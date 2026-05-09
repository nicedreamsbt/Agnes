import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import { Bank, getConfig, MarginfiAccountWrapper, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { loadConfig } from "./config.js";
import { printBankCatalog, printBankInfo } from "./bank-summary.js";
import { createGrpcStream } from "./yellowstone.js";
import { getActiveBalances, printAccountState, summarizeAccountState } from "./health.js";
import { identifyMarginfiAccount } from "./idl.js";
import { bankMatchesVenueFilter, inferBankVenue, summarizeVenueCounts } from "./venues.js";

class ReadOnlyWallet {
  constructor() {
    this.payer = Keypair.generate();
    this.publicKey = this.payer.publicKey;
  }
  async signTransaction() {
    throw new Error("Read-only monitor wallet cannot sign transactions");
  }
  async signAllTransactions() {
    throw new Error("Read-only monitor wallet cannot sign transactions");
  }
}

class MarginfiGrpcMonitor {
  constructor(config) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.wallet = new ReadOnlyWallet();
    this.accounts = new Map();
    this.rawAccountData = new Map();
    this.banks = new Map();
    this.mints = new Map();
    this.oracleRaw = new Map();
    this.oracleToBanks = new Map();
    this.bankToAccounts = new Map();
    this.bankToVenue = new Map();
  }

  async start() {
    await this.initializeClient();
    await this.preloadStaticMarketData();
    await this.preloadMarginfiAccounts();
    this.printStartupSummary();

    if (this.config.marketRefreshMs > 0) {
      setInterval(() => this.refreshMarketData("timer").catch(console.error), this.config.marketRefreshMs).unref();
    }

    const trackedAccounts = {
      explicitAccounts: new Set(this.accounts.keys()),
      marketAccounts: new Set([
        ...this.banks.keys(),
        ...this.mints.keys(),
        ...this.oracleRaw.keys(),
        ...this.oracleToBanks.keys(),
      ]),
    };
    await createGrpcStream(this.config, trackedAccounts, (update) => this.handleAccountUpdate(update));
  }

  async initializeClient() {
    const sdkConfig = getConfig(this.config.marginfiEnvironment);
    this.client = await MarginfiClient.fetch(sdkConfig, this.wallet, this.connection);
  }

  async preloadStaticMarketData() {
    this.banks.clear();
    this.bankToVenue.clear();
    this.oracleToBanks.clear();

    for (const bank of this.getClientBanks()) {
      const bankKey = bank.address.toBase58();
      this.banks.set(bankKey, bank);
      this.bankToVenue.set(bankKey, inferBankVenue(bank));
      this.indexBankOracles(bank);
    }

    await this.preloadMints();
    if (this.config.printBankCatalog) printBankCatalog(this.banks.values());
  }

  async preloadMints() {
    const mintKeys = Array.from(new Set([...this.banks.values()].map((bank) => bank.mint.toBase58())));
    const infos = await this.connection.getMultipleAccountsInfo(mintKeys.map((key) => new PublicKey(key)), "confirmed");
    infos.forEach((info, index) => {
      if (!info) return;
      try {
        const address = new PublicKey(mintKeys[index]);
        const mint = unpackMint(address, info, info.owner);
        this.mints.set(address.toBase58(), mint);
      } catch (error) {
        console.warn(`Unable to decode mint ${mintKeys[index]}: ${error.message}`);
      }
    });
  }

  async preloadMarginfiAccounts() {
    const addresses = this.config.accountAllowList.length
      ? this.config.accountAllowList.map((key) => new PublicKey(key))
      : await this.client.getAllMarginfiAccountAddresses();

    for (let offset = 0; offset < addresses.length; offset += 100) {
      const batch = addresses.slice(offset, offset + 100);
      const infos = await this.connection.getMultipleAccountsInfo(batch, "confirmed");
      infos.forEach((info, index) => {
        if (!info) return;
        this.upsertMarginfiAccount(batch[index], info.data);
      });
      console.log(`preloaded accounts ${Math.min(offset + batch.length, addresses.length)}/${addresses.length}`);
    }
  }

  async handleAccountUpdate(update) {
    if (!update.pubkey || update.data.length === 0) return;

    if (this.accounts.has(update.pubkey)) {
      this.upsertMarginfiAccount(new PublicKey(update.pubkey), update.data);
      const summary = summarizeAccountState(this.accounts.get(update.pubkey), this.client);
      printAccountState(`[account update slot=${update.slot}]`, summary);
      return;
    }

    if (this.banks.has(update.pubkey)) {
      this.upsertBank(new PublicKey(update.pubkey), update.data);
      this.printAccountsForBanks([update.pubkey], `[bank update slot=${update.slot}]`);
      return;
    }

    if (this.oracleToBanks.has(update.pubkey)) {
      this.oracleRaw.set(update.pubkey, update.data);
      if (this.config.refreshOraclesOnUpdate) await this.refreshMarketData(`oracle ${update.pubkey}`);
      this.printAccountsForOracle(update.pubkey, update.slot);
      return;
    }

    if (this.mints.has(update.pubkey)) {
      await this.refreshMint(update.pubkey, update.data);
      return;
    }

    if (update.owner === this.config.marginfiProgramId) {
      this.handleUnknownProgramAccount(update);
    }
  }

  upsertMarginfiAccount(address, data) {
    const account = MarginfiAccountWrapper.fromAccountDataRaw(address, this.client, Buffer.from(data));
    this.rawAccountData.set(address.toBase58(), Buffer.from(data));
    this.accounts.set(address.toBase58(), account);
    this.reindexAccount(account);
  }

  handleUnknownProgramAccount(update) {
    const idlAccount = identifyMarginfiAccount(update.data);
    console.log(
      `[program account slot=${update.slot}] account=${update.pubkey} type=${idlAccount.type} discriminator=${idlAccount.discriminator}`
    );

    if (idlAccount.type === "MarginfiAccount") {
      this.tryTrackNewMarginfiAccount(update);
      return;
    }

    if (idlAccount.type === "Bank") {
      this.upsertBank(new PublicKey(update.pubkey), update.data);
      this.printAccountsForBanks([update.pubkey], `[new bank slot=${update.slot}]`);
    }
  }

  tryTrackNewMarginfiAccount(update) {
    try {
      const address = new PublicKey(update.pubkey);
      this.upsertMarginfiAccount(address, update.data);
      const summary = summarizeAccountState(this.accounts.get(update.pubkey), this.client);
      printAccountState(`[new account slot=${update.slot}]`, summary);
    } catch (error) {
      console.warn(`Unable to decode ${update.pubkey} as MarginfiAccount: ${error.message}`);
    }
  }

  upsertBank(address, data) {
    const previous = this.banks.get(address.toBase58());
    const metadata = previous?.meta || previous?.metadata;
    const bank = Bank.fromBuffer(address, Buffer.from(data), metadata);
    this.banks.set(address.toBase58(), bank);
    this.bankToVenue.set(address.toBase58(), inferBankVenue(bank));
    this.indexBankOracles(bank);
    this.patchClientBank(bank);
    printBankInfo(bank, "  updated bank");
  }

  indexBankOracles(bank) {
    const bankKey = bank.address.toBase58();
    for (const bankSet of this.oracleToBanks.values()) bankSet.delete(bankKey);
    for (const oracleKey of bank.config?.oracleKeys || []) {
      const oracle = oracleKey.toBase58();
      if (!this.oracleToBanks.has(oracle)) this.oracleToBanks.set(oracle, new Set());
      this.oracleToBanks.get(oracle).add(bankKey);
      this.oracleRaw.set(oracle, undefined);
    }
  }

  async refreshMint(address, data) {
    try {
      const info = { data: Buffer.from(data), owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), executable: false, lamports: 0 };
      this.mints.set(address, unpackMint(new PublicKey(address), info, info.owner));
    } catch (error) {
      console.warn(`Unable to refresh mint ${address}: ${error.message}`);
    }
  }

  rebuildAccountIndex() {
    this.bankToAccounts.clear();
    for (const account of this.accounts.values()) this.reindexAccount(account);
  }

  reindexAccount(account) {
    for (const set of this.bankToAccounts.values()) set.delete(account.address.toBase58());
    for (const balance of getActiveBalances(account)) {
      const bank = balance.bankPk.toBase58();
      if (!this.bankToAccounts.has(bank)) this.bankToAccounts.set(bank, new Set());
      this.bankToAccounts.get(bank).add(account.address.toBase58());
    }
  }

  async refreshMarketData(reason) {
    console.log(`refreshing SDK market data (${reason})`);
    await this.initializeClient();
    await this.preloadStaticMarketData();
    for (const [address, data] of this.rawAccountData) {
      const account = MarginfiAccountWrapper.fromAccountDataRaw(new PublicKey(address), this.client, data);
      this.accounts.set(address, account);
    }
    this.rebuildAccountIndex();
  }

  printAccountsForOracle(oracle, slot) {
    const bankSet = this.oracleToBanks.get(oracle) || new Set();
    const banks = Array.from(bankSet);
    console.log(`\n[oracle update slot=${slot}] oracle=${oracle} linkedBanks=${banks.length}`);
    this.printAccountsForBanks(banks, "[oracle-linked account]");
  }

  printAccountsForBanks(banks, prefix) {
    const affected = new Set();
    for (const bank of banks) {
      if (!this.shouldPrintBank(bank)) continue;
      for (const account of this.bankToAccounts.get(bank) || []) affected.add(account);
    }
    console.log(`${prefix} affectedAccounts=${affected.size}`);
    for (const address of affected) {
      const account = this.accounts.get(address);
      if (!account) continue;
      printAccountState(prefix, summarizeAccountState(account, this.client));
    }
  }

  shouldPrintBank(bankAddress) {
    const bank = this.banks.get(bankAddress);
    return bank ? bankMatchesVenueFilter(bank, this.config.venueAllowList) : true;
  }

  getClientBanks() {
    const banks = this.client.banks;
    if (banks instanceof Map) return banks.values();
    if (Array.isArray(banks)) return banks;
    if (banks && typeof banks === "object") return Object.values(banks);
    return [];
  }

  patchClientBank(bank) {
    if (this.client.banks instanceof Map) this.client.banks.set(bank.address.toBase58(), bank);
  }

  printStartupSummary() {
    console.log("marginfi gRPC monitor ready");
    console.log(`  banks=${this.banks.size} oracles=${this.oracleToBanks.size} mints=${this.mints.size} accounts=${this.accounts.size}`);
    console.log(`  bankVenues ${summarizeVenueCounts(this.banks.values())}`);
  }
}

const monitor = new MarginfiGrpcMonitor(loadConfig());
monitor.start().catch((error) => {
  console.error(error);
  process.exit(1);
});

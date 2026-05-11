use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};

const DEFAULT_PROGRAM_ID: &str = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const ACCOUNT_DISCRIMINATOR_NAMES: &[&str] = &[
    "Bank",
    "MarginfiAccount",
    "MarginfiGroup",
    "LendingPool",
    "OracleSetup",
    "StakedSettings",
    "FeeState",
    "Emissions",
];

fn main() -> Result<(), String> {
    if env::args().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return Ok(());
    }

    let config = Config::from_env();
    let mut monitor = RustMarginfiMonitor::new(config);
    monitor.print_startup_config();

    if let Some(path) = env::var("RUST_REPLAY_EVENTS")
        .ok()
        .filter(|value| !value.is_empty())
    {
        monitor.replay_file(&path)?;
    } else {
        println!(
            "no RUST_REPLAY_EVENTS file configured; Rust core is ready for live source wiring"
        );
    }

    Ok(())
}

fn print_help() {
    println!("marginfi-grpc-monitor-rs");
    println!("  Rust companion implementation of the marginfi account-state monitor core.");
    println!();
    println!("Environment:");
    println!("  RPC_URL, GRPC_ENDPOINT, GRPC_X_TOKEN, MARGINFI_PROGRAM_ID, MARGINFI_ACCOUNTS");
    println!("  VENUES=all|marginfi,kamino,juplend,drift,unknown");
    println!("  REFRESH_ORACLES_ON_UPDATE=true|false");
    println!("  PRINT_BANK_CATALOG=true|false");
    println!("  RUST_REPLAY_EVENTS=/path/to/events.jsonl");
}

#[derive(Debug, Clone)]
struct Config {
    rpc_url: String,
    grpc_endpoint: String,
    grpc_token: Option<String>,
    marginfi_program_id: String,
    account_allow_list: BTreeSet<String>,
    venue_allow_list: BTreeSet<String>,
    refresh_oracles_on_update: bool,
    print_bank_catalog: bool,
}

impl Config {
    fn from_env() -> Self {
        Self {
            rpc_url: env_or("RPC_URL", "https://api.mainnet-beta.solana.com"),
            grpc_endpoint: env_or("GRPC_ENDPOINT", ""),
            grpc_token: env::var("GRPC_X_TOKEN")
                .ok()
                .filter(|value| !value.is_empty()),
            marginfi_program_id: env_or("MARGINFI_PROGRAM_ID", DEFAULT_PROGRAM_ID),
            account_allow_list: split_set(&env_or("MARGINFI_ACCOUNTS", "")),
            venue_allow_list: parse_venues(&env_or("VENUES", "all")),
            refresh_oracles_on_update: parse_bool(&env_or("REFRESH_ORACLES_ON_UPDATE", "true")),
            print_bank_catalog: parse_bool(&env_or("PRINT_BANK_CATALOG", "true")),
        }
    }
}

#[derive(Debug, Clone)]
struct BankInfo {
    pubkey: String,
    mint: String,
    symbol: String,
    venue: String,
    oracle_setup: String,
    oracle_keys: Vec<String>,
    asset_weight_init: String,
    asset_weight_maint: String,
    liability_weight_init: String,
    liability_weight_maint: String,
    deposit_limit: String,
    borrow_limit: String,
}

#[derive(Debug, Clone)]
struct PositionInfo {
    bank: String,
    asset_value: f64,
    liability_value: f64,
}

#[derive(Debug, Clone)]
struct AccountInfo {
    pubkey: String,
    authority: String,
    positions: Vec<PositionInfo>,
}

#[derive(Debug, Clone)]
struct AccountUpdate {
    kind: String,
    pubkey: String,
    owner: Option<String>,
    slot: Option<String>,
    data_hex: Option<String>,
    fields: BTreeMap<String, String>,
}

struct RustMarginfiMonitor {
    config: Config,
    banks: BTreeMap<String, BankInfo>,
    accounts: BTreeMap<String, AccountInfo>,
    oracle_to_banks: BTreeMap<String, BTreeSet<String>>,
    bank_to_accounts: BTreeMap<String, BTreeSet<String>>,
    mints: BTreeSet<String>,
}

impl RustMarginfiMonitor {
    fn new(config: Config) -> Self {
        Self {
            config,
            banks: BTreeMap::new(),
            accounts: BTreeMap::new(),
            oracle_to_banks: BTreeMap::new(),
            bank_to_accounts: BTreeMap::new(),
            mints: BTreeSet::new(),
        }
    }

    fn print_startup_config(&self) {
        println!("rust marginfi monitor core ready");
        println!("  rpc_url={}", self.config.rpc_url);
        println!(
            "  grpc_endpoint={}",
            display_optional(&self.config.grpc_endpoint)
        );
        println!("  grpc_token_set={}", self.config.grpc_token.is_some());
        println!("  program={}", self.config.marginfi_program_id);
        println!(
            "  account_allow_list={}",
            self.config.account_allow_list.len()
        );
        println!("  venues={:?}", self.config.venue_allow_list);
        println!("  print_bank_catalog={}", self.config.print_bank_catalog);
        println!(
            "  refresh_oracles_on_update={}",
            self.config.refresh_oracles_on_update
        );
    }

    fn replay_file(&mut self, path: &str) -> Result<(), String> {
        let file = File::open(path).map_err(|error| format!("failed to open {path}: {error}"))?;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| format!("failed to read replay line: {error}"))?;
            if line.trim().is_empty() || line.trim_start().starts_with('#') {
                continue;
            }
            let update = parse_update_line(&line)?;
            self.handle_update(update);
        }
        Ok(())
    }

    fn handle_update(&mut self, update: AccountUpdate) {
        match update.kind.as_str() {
            "bank" => self.upsert_bank(BankInfo::from_fields(&update.pubkey, &update.fields)),
            "account" => {
                self.upsert_account(AccountInfo::from_fields(&update.pubkey, &update.fields))
            }
            "oracle" => self
                .handle_oracle_update(&update.pubkey, update.slot.as_deref().unwrap_or("unknown")),
            "mint" => {
                self.mints.insert(update.pubkey.clone());
                println!("[mint update] mint={}", update.pubkey);
            }
            "program" => self.handle_program_account(&update),
            other => println!("[ignored update] kind={other} pubkey={}", update.pubkey),
        }
    }

    fn upsert_bank(&mut self, bank: BankInfo) {
        self.remove_bank_from_oracle_index(&bank.pubkey);
        self.mints.insert(bank.mint.clone());
        for oracle in &bank.oracle_keys {
            self.oracle_to_banks
                .entry(oracle.clone())
                .or_default()
                .insert(bank.pubkey.clone());
        }
        if self.config.print_bank_catalog {
            self.print_bank_info("bank", &bank);
        }
        self.banks.insert(bank.pubkey.clone(), bank);
    }

    fn upsert_account(&mut self, account: AccountInfo) {
        self.remove_account_from_bank_index(&account.pubkey);
        for position in &account.positions {
            self.bank_to_accounts
                .entry(position.bank.clone())
                .or_default()
                .insert(account.pubkey.clone());
        }
        self.accounts
            .insert(account.pubkey.clone(), account.clone());
        self.print_account_state("account update", &account);
    }

    fn handle_oracle_update(&self, oracle: &str, slot: &str) {
        let banks = self
            .oracle_to_banks
            .get(oracle)
            .cloned()
            .unwrap_or_default();
        println!(
            "[oracle update slot={slot}] oracle={oracle} linkedBanks={}",
            banks.len()
        );
        self.print_accounts_for_banks(&banks, "oracle-linked account");
    }

    fn handle_program_account(&mut self, update: &AccountUpdate) {
        let id = update
            .data_hex
            .as_deref()
            .map(identify_marginfi_account_hex)
            .unwrap_or_else(|| IdentifiedAccount::new("unknown", ""));
        println!(
            "[program account slot={}] account={} owner={} type={} discriminator={}",
            update.slot.as_deref().unwrap_or("unknown"),
            update.pubkey,
            update.owner.as_deref().unwrap_or("unknown"),
            id.account_type,
            id.discriminator
        );
    }

    fn print_accounts_for_banks(&self, banks: &BTreeSet<String>, prefix: &str) {
        let mut accounts = BTreeSet::new();
        for bank in banks {
            if !self.should_print_bank(bank) {
                continue;
            }
            if let Some(linked) = self.bank_to_accounts.get(bank) {
                accounts.extend(linked.iter().cloned());
            }
        }
        println!("[{prefix}] affectedAccounts={}", accounts.len());
        for account in accounts {
            if let Some(account) = self.accounts.get(&account) {
                self.print_account_state(prefix, account);
            }
        }
    }

    fn should_print_bank(&self, bank: &str) -> bool {
        self.banks.get(bank).map_or(true, |bank| {
            self.config.venue_allow_list.contains(&bank.venue)
        })
    }

    fn print_account_state(&self, prefix: &str, account: &AccountInfo) {
        let assets: f64 = account
            .positions
            .iter()
            .map(|position| position.asset_value)
            .sum();
        let liabilities: f64 = account
            .positions
            .iter()
            .map(|position| position.liability_value)
            .sum();
        println!(
            "\n[{prefix}] account={} authority={} assets={assets:.6} liabilities={liabilities:.6} health={:.6}",
            account.pubkey,
            account.authority,
            assets - liabilities
        );
        for position in &account.positions {
            let (symbol, venue) = self
                .banks
                .get(&position.bank)
                .map_or(("unknown", "unknown"), |bank| {
                    (bank.symbol.as_str(), bank.venue.as_str())
                });
            println!(
                "  [{venue}:{symbol}] bank={} assets={:.6} liabilities={:.6}",
                position.bank, position.asset_value, position.liability_value
            );
        }
    }

    fn print_bank_info(&self, prefix: &str, bank: &BankInfo) {
        println!(
            "{prefix} {} venue={} address={} mint={} oracleSetup={} oracleKeys={}",
            bank.symbol,
            bank.venue,
            bank.pubkey,
            bank.mint,
            bank.oracle_setup,
            bank.oracle_keys.len()
        );
        for (index, oracle) in bank.oracle_keys.iter().enumerate() {
            println!("  oracle[{index}]={oracle}");
        }
        println!(
            "  weights asset(init={}, maint={}) liability(init={}, maint={}) limits(deposit={}, borrow={})",
            bank.asset_weight_init,
            bank.asset_weight_maint,
            bank.liability_weight_init,
            bank.liability_weight_maint,
            bank.deposit_limit,
            bank.borrow_limit
        );
    }

    fn remove_bank_from_oracle_index(&mut self, bank: &str) {
        for banks in self.oracle_to_banks.values_mut() {
            banks.remove(bank);
        }
    }

    fn remove_account_from_bank_index(&mut self, account: &str) {
        for accounts in self.bank_to_accounts.values_mut() {
            accounts.remove(account);
        }
    }
}

impl BankInfo {
    fn from_fields(pubkey: &str, fields: &BTreeMap<String, String>) -> Self {
        let symbol = field_or(fields, "symbol", short_key(pubkey));
        let venue = field_or(fields, "venue", infer_venue(&symbol));
        Self {
            pubkey: pubkey.to_owned(),
            mint: field_or(fields, "mint", "unknown"),
            symbol,
            venue,
            oracle_setup: field_or(fields, "oracle_setup", "unknown"),
            oracle_keys: split_vec(&field_or(fields, "oracles", "")),
            asset_weight_init: field_or(fields, "asset_weight_init", "unknown"),
            asset_weight_maint: field_or(fields, "asset_weight_maint", "unknown"),
            liability_weight_init: field_or(fields, "liability_weight_init", "unknown"),
            liability_weight_maint: field_or(fields, "liability_weight_maint", "unknown"),
            deposit_limit: field_or(fields, "deposit_limit", "unknown"),
            borrow_limit: field_or(fields, "borrow_limit", "unknown"),
        }
    }
}

impl AccountInfo {
    fn from_fields(pubkey: &str, fields: &BTreeMap<String, String>) -> Self {
        let positions = split_vec(&field_or(fields, "positions", ""))
            .into_iter()
            .filter_map(|raw| {
                let mut parts = raw.split(':');
                let bank = parts.next()?.to_owned();
                let asset_value = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                let liability_value = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
                Some(PositionInfo {
                    bank,
                    asset_value,
                    liability_value,
                })
            })
            .collect();
        Self {
            pubkey: pubkey.to_owned(),
            authority: field_or(fields, "authority", "unknown"),
            positions,
        }
    }
}

#[derive(Debug, Clone)]
struct IdentifiedAccount {
    account_type: String,
    discriminator: String,
}

impl IdentifiedAccount {
    fn new(account_type: &str, discriminator: &str) -> Self {
        Self {
            account_type: account_type.to_owned(),
            discriminator: discriminator.to_owned(),
        }
    }
}

fn identify_marginfi_account_hex(data_hex: &str) -> IdentifiedAccount {
    let discriminator = data_hex.chars().take(16).collect::<String>().to_lowercase();
    for account_name in ACCOUNT_DISCRIMINATOR_NAMES {
        if discriminator == anchor_discriminator_hex(account_name) {
            return IdentifiedAccount::new(account_name, &discriminator);
        }
        let lowered = lower_first(account_name);
        if discriminator == anchor_discriminator_hex(&lowered) {
            return IdentifiedAccount::new(account_name, &discriminator);
        }
    }
    IdentifiedAccount::new("unknown", &discriminator)
}

fn anchor_discriminator_hex(name: &str) -> String {
    // Anchor discriminator = first 8 bytes of sha256("account:<name>").
    // This std-only companion keeps the routing shape without adding a crypto crate;
    // the live feature should swap this for sha2::Sha256 or the marginfi IDL constants.
    match name {
        "Bank" | "bank" => "8b36c8fb8d0d9e1b".to_owned(),
        "MarginfiAccount" | "marginfiAccount" => "4373d5a3a7d791d0".to_owned(),
        "MarginfiGroup" | "marginfiGroup" => "b4c8c33a2d5d50a2".to_owned(),
        _ => String::new(),
    }
}

fn parse_update_line(line: &str) -> Result<AccountUpdate, String> {
    let mut fields = BTreeMap::new();
    for token in line.split_whitespace() {
        let Some((key, value)) = token.split_once('=') else {
            return Err(format!("invalid replay token '{token}'"));
        };
        fields.insert(key.to_owned(), value.to_owned());
    }
    let kind = field_or(&fields, "kind", "unknown");
    let pubkey = field_or(&fields, "pubkey", "unknown");
    Ok(AccountUpdate {
        kind,
        pubkey,
        owner: fields.get("owner").cloned(),
        slot: fields.get("slot").cloned(),
        data_hex: fields.get("data_hex").cloned(),
        fields,
    })
}

fn env_or(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_owned())
}

fn parse_bool(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "y"
    )
}

fn parse_venues(value: &str) -> BTreeSet<String> {
    let known = ["marginfi", "kamino", "juplend", "drift", "unknown"];
    let requested = split_set(value);
    if requested.is_empty() || requested.contains("all") {
        return known.into_iter().map(str::to_owned).collect();
    }
    requested
}

fn split_set(value: &str) -> BTreeSet<String> {
    split_vec(value).into_iter().collect()
}

fn split_vec(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

fn field_or(fields: &BTreeMap<String, String>, key: &str, fallback: impl Into<String>) -> String {
    fields.get(key).cloned().unwrap_or_else(|| fallback.into())
}

fn infer_venue(symbol: &str) -> String {
    let symbol = symbol.to_ascii_lowercase();
    if symbol.contains("kamino") || symbol.contains("klend") {
        "kamino"
    } else if symbol.contains("jup") {
        "juplend"
    } else if symbol.contains("drift") {
        "drift"
    } else {
        "marginfi"
    }
    .to_owned()
}

fn lower_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn short_key(value: &str) -> String {
    if value.len() <= 8 {
        return value.to_owned();
    }
    format!("{}…{}", &value[..4], &value[value.len() - 4..])
}

fn display_optional(value: &str) -> &str {
    if value.is_empty() {
        "<unset>"
    } else {
        value
    }
}

#[allow(dead_code)]
fn read_stdin_lines() -> impl Iterator<Item = Result<String, io::Error>> {
    io::stdin().lock().lines()
}

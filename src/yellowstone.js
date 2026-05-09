import Client from "@triton-one/yellowstone-grpc";

const COMMITMENT = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

export async function createGrpcStream(config, trackedAccounts, onAccountUpdate) {
  const client = new Client(config.grpcEndpoint, config.grpcToken, {
    "grpc.max_receive_message_length": 128 * 1024 * 1024,
  });

  if (typeof client.connect === "function") {
    await client.connect();
  }

  const stream = await client.subscribe();
  stream.on("data", (update) => {
    const accountUpdate = update.account?.account ? update.account : undefined;
    if (!accountUpdate) return;
    onAccountUpdate(normalizeAccountUpdate(accountUpdate));
  });
  stream.on("error", (err) => console.error("gRPC stream error", err));
  stream.on("end", () => console.error("gRPC stream ended"));
  stream.on("close", () => console.error("gRPC stream closed"));

  await writeSubscribeRequest(stream, buildSubscribeRequest(config, trackedAccounts));
  startPings(stream);

  return { client, stream };
}

function buildSubscribeRequest(config, trackedAccounts) {
  const explicitAccounts = Array.from(trackedAccounts.explicitAccounts).sort();
  return {
    accounts: {
      marginfi_accounts: {
        account: explicitAccounts,
        owner: [],
        filters: [],
      },
      marginfi_program: {
        account: [],
        owner: [config.marginfiProgramId],
        filters: [],
      },
      market_accounts: {
        account: Array.from(trackedAccounts.marketAccounts).sort(),
        owner: [],
        filters: [],
      },
    },
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: COMMITMENT[config.commitment] ?? COMMITMENT.processed,
  };
}

function normalizeAccountUpdate(update) {
  const account = update.account;
  return {
    pubkey: bufferLikeToBase58(account.pubkey),
    owner: bufferLikeToBase58(account.owner),
    lamports: account.lamports,
    executable: account.executable,
    rentEpoch: account.rentEpoch,
    data: Buffer.from(account.data || []),
    slot: update.slot?.toString?.() ?? String(update.slot),
    isStartup: update.isStartup,
  };
}

async function writeSubscribeRequest(stream, request) {
  await new Promise((resolve, reject) => {
    stream.write(request, (err) => (err ? reject(err) : resolve()));
  });
}

function startPings(stream) {
  setInterval(() => {
    stream.write({ ping: { id: Date.now() } }, () => undefined);
  }, 15_000).unref();
}

function bufferLikeToBase58(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  // Lazy import avoids a hard dependency at module-check time.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const byte of Buffer.from(value)) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const byte of Buffer.from(value)) {
    if (byte === 0) digits.push(0);
    else break;
  }
  return digits.reverse().map((digit) => alphabet[digit]).join("");
}

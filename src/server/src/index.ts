
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

// ============================================================
// Configuration
// ============================================================

const PORT = Number(process.env.PORT || 8080);
const STARTING_BALANCE = 100_000_000;
const MAX_LEVERAGE = 100;
const MAX_CANDLES = 1000;

const PRICE_POLL_INTERVAL = 5000;
const BROADCAST_INTERVAL = 2000;
const MAX_PRICE_AGE = 30000;

const MARKET = "BTC_IRT";

const BITPIN_ENDPOINTS = [
  "https://api.bitpin.ir/v1/mkt/tickers/",
  "https://api.bitpin.ir/v1/mkt/markets/"
];

type Side = "LONG" | "SHORT";

type MarketStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "ERROR"
  | "DISCONNECTED";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Position = {
  id: string;
  side: Side;
  quantity: number;
  entry: number;
  leverage: number;
  margin: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
};

type Trader = {
  id: string;
  name: string;
  balance: number;
  positions: Position[];
};

type Quote = {
  price: number;
  timestamp: number;
  endpoint: string;
};

// ============================================================
// Shared state
// ============================================================

const traders = new Map<string, Trader>();
const sockets = new Map<string, WebSocket>();

let marketPrice = 0;
let marketStatus: MarketStatus = "CONNECTING";
let marketError = "";
let lastQuoteAt = 0;
let activeEndpoint = "";

const candles: Candle[] = [];

let polling = false;
let shuttingDown = false;

let priceTimer: ReturnType<typeof setInterval> | undefined;
let gameTimer: ReturnType<typeof setInterval> | undefined;

// ============================================================
// HTTP server
// ============================================================

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify({
      ok: true,
      provider: "Bitpin",
      market: MARKET,
      status: effectiveMarketStatus(),
      price: marketPrice,
      lastQuoteAt,
      endpoint: activeEndpoint || null,
      error: marketError || null,
      players: sockets.size
    }));

    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({
  server,
  path: "/"
});

// ============================================================
// Bitpin response parsing
// ============================================================

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parsePrice(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const valueAsNumber = Number(
    String(value).replace(/,/g, "").trim()
  );

  if (!Number.isFinite(valueAsNumber) || valueAsNumber <= 0) {
    return undefined;
  }

  return valueAsNumber;
}

function getRecordSymbol(record: any): string {
  if (!record || typeof record !== "object") {
    return "";
  }

  const candidates = [
    record.code,
    record.symbol,
    record.market_code,
    record.marketCode,
    record.pair,
    record.market?.code,
    record.market?.symbol
  ];

  for (const candidate of candidates) {
    const result = normalizeSymbol(candidate);
    if (result) return result;
  }

  return "";
}

function getRecordPrice(record: any): number | undefined {
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const fields = [
    record.price,
    record.last,
    record.last_price,
    record.lastPrice,
    record.last_trade_price,
    record.close
  ];

  for (const value of fields) {
    const result = parsePrice(value);
    if (result !== undefined) return result;
  }

  const nestedRecords = [
    record.order_book_info,
    record.internal_price_info,
    record.price_info,
    record.ticker
  ];

  for (const nested of nestedRecords) {
    if (!nested || typeof nested !== "object") continue;

    const nestedFields = [
      nested.price,
      nested.last,
      nested.last_price,
      nested.lastPrice,
      nested.close
    ];

    for (const value of nestedFields) {
      const result = parsePrice(value);
      if (result !== undefined) return result;
    }
  }

  return undefined;
}

function extractBitpinPrice(payload: unknown): number | undefined {
  const visited = new Set<object>();

  function search(
    node: any,
    keyHint = "",
    depth = 0
  ): number | undefined {
    if (
      node === null ||
      node === undefined ||
      typeof node !== "object" ||
      depth > 20
    ) {
      return undefined;
    }

    if (visited.has(node)) return undefined;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const result = search(item, "", depth + 1);
        if (result !== undefined) return result;
      }

      return undefined;
    }

    const symbol = getRecordSymbol(node);
    const hintedSymbol = normalizeSymbol(keyHint);

    if (
      symbol === "BTCIRT" ||
      hintedSymbol === "BTCIRT"
    ) {
      const result = getRecordPrice(node);
      if (result !== undefined) return result;
    }

    // Handle objects indexed by BTC_IRT.
    for (const [key, value] of Object.entries(node)) {
      if (normalizeSymbol(key) === "BTCIRT") {
        const result = getRecordPrice(value);

        if (result !== undefined) return result;
      }
    }

    // Handle common wrappers such as results, data and tickers.
    for (const [key, value] of Object.entries(node)) {
      const result = search(value, key, depth + 1);

      if (result !== undefined) return result;
    }

    return undefined;
  }

  return search(payload);
}

// ============================================================
// Bitpin polling
// ============================================================

async function fetchBitpinPrice(): Promise<Quote> {
  const errors: string[] = [];

  for (const endpoint of BITPIN_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "BitpinTradingGame/1.0"
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        errors.push(`${endpoint}: HTTP ${response.status}`);
        continue;
      }

      const payload = await response.json();
      const price = extractBitpinPrice(payload);

      if (price === undefined) {
        errors.push(
          `${endpoint}: BTC_IRT price not found in response`
        );
        continue;
      }

      return {
        price,
        timestamp: Date.now(),
        endpoint
      };
    } catch (error) {
      errors.push(
        `${endpoint}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  throw new Error(errors.join(" | "));
}

// ============================================================
// Candles
// ============================================================

function updateQuote(quote: Quote): void {
  marketPrice = quote.price;
  lastQuoteAt = quote.timestamp;
  activeEndpoint = quote.endpoint;

  marketStatus = "CONNECTED";
  marketError = "";

  // Lightweight Charts uses Unix timestamps in seconds.
  const minute = Math.floor(quote.timestamp / 60000) * 60;
  const current = candles[candles.length - 1];

  if (!current || current.time !== minute) {
    candles.push({
      time: minute,
      open: quote.price,
      high: quote.price,
      low: quote.price,
      close: quote.price
    });

    if (candles.length > MAX_CANDLES) {
      candles.shift();
    }
  } else {
    current.high = Math.max(current.high, quote.price);
    current.low = Math.min(current.low, quote.price);
    current.close = quote.price;
  }
}

function effectiveMarketStatus(): MarketStatus {
  if (
    lastQuoteAt > 0 &&
    Date.now() - lastQuoteAt > MAX_PRICE_AGE
  ) {
    return "ERROR";
  }

  return marketStatus;
}

async function pollMarket(): Promise<void> {
  if (polling || shuttingDown) return;

  polling = true;

  try {
    const quote = await fetchBitpinPrice();

    updateQuote(quote);

    console.log(
      `[BITPIN] ${MARKET} price=${quote.price} ` +
      `endpoint=${quote.endpoint}`
    );
  } catch (error) {
    marketStatus = "ERROR";

    marketError =
      error instanceof Error ? error.message : String(error);

    console.error(`[BITPIN] MARKET DATA ERROR: ${marketError}`);
  } finally {
    polling = false;
    broadcastAll();
  }
}

// ============================================================
// Trading calculations
// ============================================================

function createTrader(id: string): Trader {
  return {
    id,
    name: "Trader",
    balance: STARTING_BALANCE,
    positions: []
  };
}

function getTrader(id: string): Trader {
  let trader = traders.get(id);

  if (!trader) {
    trader = createTrader(id);
    traders.set(id, trader);
  }

  return trader;
}

function calculatePnl(position: Position): number {
  const direction = position.side === "LONG" ? 1 : -1;

  return (
    (marketPrice - position.entry) *
    position.quantity *
    direction
  );
}

function liquidationPrice(position: Position): number {
  // Simplified simulation only; not an exchange liquidation formula.
  const movement = position.margin * 0.9 / position.quantity;

  return position.side === "LONG"
    ? position.entry - movement
    : position.entry + movement;
}

function calculateEquity(trader: Trader): number {
  return trader.balance + trader.positions.reduce(
    (total, position) => {
      const positionValue =
        position.margin + calculatePnl(position);

      return total + Math.max(0, positionValue);
    },
    0
  );
}

function parseOptionalPrice(
  value: unknown,
  fieldName: string
): number | undefined {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive price.`);
  }

  return parsed;
}

function openPosition(
  trader: Trader,
  side: Side,
  margin: number,
  leverage: number,
  stopLoss?: number,
  takeProfit?: number
): Position {
  if (
    marketPrice <= 0 ||
    lastQuoteAt === 0 ||
    Date.now() - lastQuoteAt > MAX_PRICE_AGE
  ) {
    throw new Error(
      "BITPIN_PRICE_UNAVAILABLE: Waiting for a fresh BTC_IRT price."
    );
  }

  if (!Number.isFinite(margin) || margin <= 0) {
    throw new Error("Margin must be greater than zero.");
  }

  if (
    !Number.isFinite(leverage) ||
    leverage < 1 ||
    leverage > MAX_LEVERAGE
  ) {
    throw new Error(
      `Leverage must be between 1 and ${MAX_LEVERAGE}.`
    );
  }

  if (margin > trader.balance) {
    throw new Error("Not enough balance.");
  }

  const position: Position = {
    id: crypto.randomUUID(),
    side,
    quantity: margin * leverage / marketPrice,
    entry: marketPrice,
    leverage,
    margin,
    stopLoss,
    takeProfit,
    openedAt: Date.now()
  };

  trader.balance -= margin;
  trader.positions.push(position);

  return position;
}

function closePosition(
  trader: Trader,
  positionId: string,
  forceLiquidation = false
): number {
  const position = trader.positions.find(
    item => item.id === positionId
  );

  if (!position) {
    throw new Error("Position not found.");
  }

  const rawPnl = calculatePnl(position);

  const realizedPnl = forceLiquidation
    ? -position.margin
    : Math.max(-position.margin, rawPnl);

  const released = position.margin + realizedPnl;

  trader.balance += released;

  trader.positions = trader.positions.filter(
    item => item.id !== positionId
  );

  // Return the margin and PnL released into the account.
  return released;
}

function checkPositionExits(): void {
  if (marketPrice <= 0) return;

  for (const trader of traders.values()) {
    for (const position of [...trader.positions]) {
      const liquidation = liquidationPrice(position);

      const liquidated = position.side === "LONG"
        ? marketPrice <= liquidation
        : marketPrice >= liquidation;

      if (liquidated) {
        closePosition(trader, position.id, true);
        continue;
      }

      const stopHit =
        position.stopLoss !== undefined &&
        (position.side === "LONG"
          ? marketPrice <= position.stopLoss
          : marketPrice >= position.stopLoss);

      const targetHit =
        position.takeProfit !== undefined &&
        (position.side === "LONG"
          ? marketPrice >= position.takeProfit
          : marketPrice <= position.takeProfit);

      if (stopHit || targetHit) {
        closePosition(trader, position.id);
      }
    }
  }
}

// ============================================================
// State snapshots
// ============================================================

function traderSnapshot(trader: Trader) {
  return {
    id: trader.id,
    name: trader.name,
    balance: trader.balance,
    equity: calculateEquity(trader),

    positions: trader.positions.map(position => ({
      ...position,
      pnl: calculatePnl(position),
      liquidationPrice: liquidationPrice(position)
    }))
  };
}

function marketSnapshot() {
  return {
    source: "Bitpin",
    product: MARKET,
    priceUnit: "IRT",
    status: effectiveMarketStatus(),
    error: marketError,
    endpoint: activeEndpoint,
    price: marketPrice,
    lastQuoteAt,
    candles
  };
}

function playersSnapshot() {
  return [...traders.values()].map(trader => ({
    id: trader.id,
    name: trader.name,
    balance: trader.balance,
    equity: calculateEquity(trader),
    positions: trader.positions.length
  }));
}

// ============================================================
// WebSocket broadcasting
// ============================================================

function broadcastAll(): void {
  const market = marketSnapshot();
  const players = playersSnapshot();

  for (const [id, socket] of sockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;

    socket.send(JSON.stringify({
      type: "state",
      market,
      trader: traderSnapshot(getTrader(id)),
      players
    }));
  }
}

// ============================================================
// Client messages
// ============================================================

wss.on("connection", (socket, request) => {
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`
  );

  const requestedId = url.searchParams.get("playerId") || "";

  const playerId = /^[a-zA-Z0-9_-]{8,80}$/.test(requestedId)
    ? requestedId
    : crypto.randomUUID();

  const previousSocket = sockets.get(playerId);

  if (previousSocket && previousSocket !== socket) {
    previousSocket.close();
  }

  sockets.set(playerId, socket);

  const trader = getTrader(playerId);

  socket.send(JSON.stringify({
    type: "hello",
    id: playerId,
    trader: traderSnapshot(trader),
    market: marketSnapshot(),
    players: playersSnapshot()
  }));

  socket.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === "rename") {
        trader.name =
          String(message.name || "Trader").trim().slice(0, 24) ||
          "Trader";
      }

      if (message.type === "open") {
        if (
          message.side !== "LONG" &&
          message.side !== "SHORT"
        ) {
          throw new Error("Side must be LONG or SHORT.");
        }

        openPosition(
          trader,
          message.side as Side,
          Number(message.margin),
          Number(message.leverage),
          parseOptionalPrice(message.stopLoss, "Stop Loss"),
          parseOptionalPrice(message.takeProfit, "Take Profit")
        );
      }

      if (message.type === "close") {
        closePosition(trader, String(message.positionId));
      }

      if (message.type === "reverse") {
        const previous = trader.positions.find(
          position => position.id === String(message.positionId)
        );

        if (previous) {
          const previousSide = previous.side;
          const previousLeverage = previous.leverage;

          const releasedMargin = closePosition(
            trader,
            previous.id
          );

          if (releasedMargin > 0 && marketPrice > 0) {
            const oppositeSide: Side =
              previousSide === "LONG" ? "SHORT" : "LONG";

            openPosition(
              trader,
              oppositeSide,
              releasedMargin,
              previousLeverage
            );
          }
        }
      }

      if (message.type === "setStops") {
        const position = trader.positions.find(
          item => item.id === String(message.positionId)
        );

        if (!position) {
          throw new Error("Position not found.");
        }

        if (Object.hasOwn(message, "stopLoss")) {
          position.stopLoss = parseOptionalPrice(
            message.stopLoss,
            "Stop Loss"
          );
        }

        if (Object.hasOwn(message, "takeProfit")) {
          position.takeProfit = parseOptionalPrice(
            message.takeProfit,
            "Take Profit"
          );
        }
      }

      broadcastAll();
    } catch (error) {
      socket.send(JSON.stringify({
        type: "error",
        code: "TRADING_REQUEST_ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Request failed."
      }));
    }
  });

  socket.on("close", () => {
    // Do not delete a newer socket if the old one closes later.
    if (sockets.get(playerId) === socket) {
      sockets.delete(playerId);
    }

    broadcastAll();
  });

  socket.on("error", error => {
    console.error(`[PLAYER ${playerId}] ${error.message}`);
  });
});

// ============================================================
// Game loop
// ============================================================

gameTimer = setInterval(() => {
  checkPositionExits();
  broadcastAll();
}, BROADCAST_INTERVAL);

// ============================================================
// Start server
// ============================================================

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`[SERVER] ${error.message}`);

  if (error.code === "EADDRINUSE") {
    console.error(
      `[SERVER] Port ${PORT} is already in use. Stop the old server first.`
    );

    process.exit(1);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log(" BITPIN BTC TRADING GAME");
  console.log(" PROVIDER: BITPIN PUBLIC MARKET API");
  console.log(" MARKET: BTC_IRT");
  console.log(` PRICE POLLING: ${PRICE_POLL_INTERVAL / 1000}s`);
  console.log(` GAME BROADCAST: ${BROADCAST_INTERVAL / 1000}s`);
  console.log(` SERVER: http://localhost:${PORT}`);
  console.log("============================================");

  void pollMarket();

  priceTimer = setInterval(() => {
    void pollMarket();
  }, PRICE_POLL_INTERVAL);
});

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown(): void {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log("[SERVER] Shutting down...");

  if (priceTimer) clearInterval(priceTimer);
  if (gameTimer) clearInterval(gameTimer);

  marketStatus = "DISCONNECTED";

  for (const socket of sockets.values()) {
    socket.close();
  }

  wss.close();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

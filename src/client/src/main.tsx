
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  IPriceLine,
} from "lightweight-charts";
import "./style.css";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Position = {
  id: string;
  side: "LONG" | "SHORT";
  entry: number;
  quantity: number;
  leverage: number;
  margin: number;
  stopLoss?: number;
  takeProfit?: number;
  pnl: number;
  liquidationPrice: number;
  openedAt: number;
};

type Trader = {
  id: string;
  name: string;
  balance: number;
  equity: number;
  positions: Position[];
};

type Market = {
  source: string;
  product: string;
  status: string;
  error: string;
  price: number;
  lastQuoteAt: number;
  candles: Candle[];
};

const playerIdKey = "bitpin-game-player-id";

function getPlayerId(): string {
  const saved = localStorage.getItem(playerIdKey);

  if (saved && /^[a-zA-Z0-9_-]{8,80}$/.test(saved)) {
    return saved;
  }

  const id = crypto.randomUUID().replaceAll("-", "");
  localStorage.setItem(playerIdKey, id);
  return id;
}

const playerId = getPlayerId();

function getSavedName(): string {
  return localStorage.getItem("trader-name") || "Trader";
}

function formatNumber(value: number): string {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatMoney(value: number): string {
  return `${formatNumber(value)} تومان`;
}

// ============================================================
// Chart
// ============================================================

function Chart({
  candles,
  positions,
}: {
  candles: Candle[];
  positions: Position[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const series = useRef<any>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const initialized = useRef(false);

  useEffect(() => {
    if (!container.current) return;

    const instance = createChart(container.current, {
      layout: {
        background: {
          type: ColorType.Solid,
          color: "#050505",
        },
        textColor: "#a9a9a9",
      },
      grid: {
        vertLines: { color: "#151515" },
        horzLines: { color: "#151515" },
      },
      rightPriceScale: {
        borderColor: "#292929",
        scaleMargins: {
          top: 0.12,
          bottom: 0.12,
        },
      },
      timeScale: {
        borderColor: "#292929",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: "#454545" },
        horzLine: { color: "#454545" },
      },
    });

    const candleSeries = instance.addSeries(CandlestickSeries, {
      upColor: "#20b26b",
      downColor: "#e5484d",
      borderVisible: false,
      wickUpColor: "#20b26b",
      wickDownColor: "#e5484d",
    });

    chart.current = instance;
    series.current = candleSeries;

    const resize = () => {
      if (!container.current) return;

      instance.applyOptions({
        width: container.current.clientWidth,
        height: container.current.clientHeight,
      });
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();

    return () => {
      observer.disconnect();

      for (const line of priceLines.current) {
        try {
          candleSeries.removePriceLine(line);
        } catch {
          // The chart may already have been disposed.
        }
      }

      priceLines.current = [];
      instance.remove();
      chart.current = null;
      series.current = null;
      initialized.current = false;
    };
  }, []);

  // The server sends market.candles, not a single state.candle.
  useEffect(() => {
    if (!series.current || candles.length === 0) return;

    series.current.setData(
      candles.map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })) as any
    );

    if (!initialized.current) {
      chart.current?.timeScale().fitContent();
      initialized.current = true;
    }
  }, [candles]);

  // Draw entry, Stop Loss and Take Profit levels.
  useEffect(() => {
    if (!series.current) return;

    for (const line of priceLines.current) {
      try {
        series.current.removePriceLine(line);
      } catch {
        // Ignore a line that was already removed.
      }
    }

    priceLines.current = [];

    function addLine(
      price: number | undefined,
      title: string,
      color: string
    ) {
      if (
        price === undefined ||
        price === null ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return;
      }

      const line = series.current.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title,
      });

      priceLines.current.push(line);
    }

    for (const position of positions) {
      addLine(
        position.entry,
        `${position.side} ${position.leverage}x`,
        "#d6d6d6"
      );

      addLine(position.stopLoss, "SL", "#e5484d");
      addLine(position.takeProfit, "TP", "#20b26b");
    }
  }, [positions]);

  return <div ref={container} className="chart" />;
}

// ============================================================
// Main application
// ============================================================

function App() {
  const socket = useRef<WebSocket | null>(null);

  const [connected, setConnected] = useState(false);
  const [name, setName] = useState(getSavedName());

  const [market, setMarket] = useState<Market>({
    source: "Bitpin",
    product: "BTC_IRT",
    status: "CONNECTING",
    error: "",
    price: 0,
    lastQuoteAt: 0,
    candles: [],
  });

  const [trader, setTrader] = useState<Trader | null>(null);
  const [players, setPlayers] = useState<any[]>([]);

  const [modal, setModal] = useState<"LONG" | "SHORT" | null>(null);
  const [margin, setMargin] = useState("1000000");
  const [leverage, setLeverage] = useState("10");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");

  const [errorMessage, setErrorMessage] = useState("");

  // Maintain ONE connection and reuse it for all commands.
  useEffect(() => {
    const ws = new WebSocket(
      `ws://${window.location.hostname}:8080/?playerId=${encodeURIComponent(
        playerId
      )}`
    );

    socket.current = ws;

    ws.onopen = () => {
      setConnected(true);

      ws.send(
        JSON.stringify({
          type: "rename",
          name,
        })
      );
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
      setErrorMessage(
        "ارتباط با سرور برقرار نیست. مطمئن شو سرور روی پورت 8080 روشن است."
      );
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (
          message.type === "hello" ||
          message.type === "state"
        ) {
          if (message.market) {
            setMarket(message.market);
          }

          if (message.trader) {
            setTrader(message.trader);
          }

          if (Array.isArray(message.players)) {
            setPlayers(message.players);
          }

          setErrorMessage("");
        }

        if (message.type === "error") {
          setErrorMessage(message.message || "خطای نامشخص");
        }
      } catch (error) {
        console.error("Invalid server message:", error);
      }
    };

    return () => {
      socket.current = null;
      ws.close();
    };
  }, []);

  function send(message: unknown) {
    const ws = socket.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setErrorMessage("اتصال WebSocket هنوز برقرار نشده است.");
      return false;
    }

    ws.send(JSON.stringify(message));
    return true;
  }

  const price = Number(market.price || 0);
  const candles = market.candles || [];
  const positions = trader?.positions || [];
  const mainPosition = positions[0] || null;

  const percentChange = useMemo(() => {
    if (candles.length < 2 || price <= 0) return 0;

    const reference =
      candles[Math.max(0, candles.length - 61)].close;

    if (!reference) return 0;

    return ((price - reference) / reference) * 100;
  }, [candles, price]);

  function openOrder(side: "LONG" | "SHORT") {
    setModal(side);
    setMargin("1000000");
    setLeverage("10");
    setStopLoss("");
    setTakeProfit("");
    setErrorMessage("");
  }

  function submitOrder(event: React.FormEvent) {
    event.preventDefault();

    if (!modal) return;

    const success = send({
      type: "open",
      side: modal,
      margin: Number(margin),
      leverage: Number(leverage),
      stopLoss: stopLoss.trim()
        ? Number(stopLoss)
        : null,
      takeProfit: takeProfit.trim()
        ? Number(takeProfit)
        : null,
    });

    if (success) {
      setModal(null);
    }
  }

  function editStops(position: Position) {
    const sl = window.prompt(
      "Stop Loss price (leave empty to remove)",
      position.stopLoss?.toString() || ""
    );

    if (sl === null) return;

    const tp = window.prompt(
      "Take Profit price (leave empty to remove)",
      position.takeProfit?.toString() || ""
    );

    if (tp === null) return;

    send({
      type: "setStops",
      positionId: position.id,
      stopLoss: sl.trim() ? Number(sl) : null,
      takeProfit: tp.trim() ? Number(tp) : null,
    });
  }

  return (
    <div className="app">
      <div className="marketHeader">
        <div className="marketInfo">
          <span className="symbol">BTC_IRT</span>
          <span className="pair">Bitcoin / Toman</span>
          <span className="interval">1m</span>

          <span className="price">
            {price > 0 ? formatNumber(price) : "Waiting for Bitpin…"}
          </span>

          <span
            className={
              percentChange >= 0
                ? "change up"
                : "change down"
            }
          >
            {percentChange >= 0 ? "+" : ""}
            {percentChange.toFixed(2)}%
          </span>

          <span className={connected ? "active" : "loss"}>
            {connected ? market.status : "SERVER OFFLINE"}
          </span>
        </div>

        <div className="account">
          <input
            value={name}
            aria-label="Player name"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              localStorage.setItem("trader-name", name);
              send({ type: "rename", name });
            }}
          />

          <b>
            {formatMoney(Number(trader?.equity ?? 0))}
          </b>
        </div>
      </div>

      {market.status !== "CONNECTED" && (
        <div className="feedWarning">
          <b>Bitpin:</b> {market.status}
          {market.error ? ` — ${market.error}` : ""}
        </div>
      )}

      {errorMessage && (
        <div className="feedWarning">
          {errorMessage}
          <button onClick={() => setErrorMessage("")}>
            ×
          </button>
        </div>
      )}

      <div className="tradeButtons">
        <button
          className="long"
          onClick={() => openOrder("LONG")}
        >
          LONG
        </button>

        <button
          className="short"
          onClick={() => openOrder("SHORT")}
        >
          SHORT
        </button>
      </div>

      <main>
        <section className="chartWrap">
          <Chart
            candle={undefined as any}
            candles={candles}
            positions={positions}
          />

          {candles.length === 0 && (
            <div className="empty">
              {market.status === "CONNECTED"
                ? "در انتظار اولین کندل بازار…"
                : "در انتظار دریافت قیمت از API بیت‌پین…"}
            </div>
          )}

          {mainPosition && (
            <div className="positionBar">
              <span
                className={
                  mainPosition.side === "LONG"
                    ? "posLong"
                    : "posShort"
                }
              >
                {mainPosition.side} {mainPosition.leverage}x
              </span>

              <span>
                Entry {formatNumber(mainPosition.entry)}
              </span>

              <span
                className={
                  mainPosition.pnl >= 0 ? "profit" : "loss"
                }
              >
                {mainPosition.pnl >= 0 ? "+" : ""}
                {formatMoney(mainPosition.pnl)}
              </span>

              <button onClick={() => editStops(mainPosition)}>
                SL / TP
              </button>

              <button
                onClick={() =>
                  send({
                    type: "close",
                    positionId: mainPosition.id,
                  })
                }
              >
                Close
              </button>

              <button
                onClick={() =>
                  send({
                    type: "reverse",
                    positionId: mainPosition.id,
                  })
                }
              >
                Reverse
              </button>
            </div>
          )}
        </section>

        <aside>
          <div className="sideTitle">POSITIONS</div>

          {positions.length === 0 && (
            <div className="empty">No open position</div>
          )}

          {positions.map((position) => (
            <div className="player" key={position.id}>
              <b>
                {position.side} {position.leverage}x
              </b>

              <div className="row">
                <span>Entry</span>
                <b>{formatNumber(position.entry)}</b>
              </div>

              <div className="row">
                <span>Margin</span>
                <b>{formatMoney(position.margin)}</b>
              </div>

              <div className="row">
                <span>Liquidation</span>
                <b>{formatNumber(position.liquidationPrice)}</b>
              </div>

              <div className="row">
                <span>PnL</span>
                <b
                  className={
                    position.pnl >= 0 ? "profit" : "loss"
                  }
                >
                  {formatMoney(position.pnl)}
                </b>
              </div>

              <button onClick={() => editStops(position)}>
                Edit SL / TP
              </button>

              <button
                onClick={() =>
                  send({
                    type: "reverse",
                    positionId: position.id,
                  })
                }
              >
                Reverse
              </button>

              <button
                onClick={() =>
                  send({
                    type: "close",
                    positionId: position.id,
                  })
                }
              >
                Close
              </button>
            </div>
          ))}

          <div className="sideTitle playersTitle">
            PLAYERS
          </div>

          {players.map((player) => (
            <div className="player" key={player.id}>
              <span>{player.name}</span>
              <b>{formatMoney(Number(player.equity))}</b>
              <small>
                {player.positions} open position(s)
              </small>
            </div>
          ))}
        </aside>
      </main>

      {modal && (
        <div
          className="backdrop"
          onMouseDown={() => setModal(null)}
        >
          <form
            className="modal"
            onSubmit={submitOrder}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modalHead">
              <span>Open {modal}</span>

              <button
                type="button"
                onClick={() => setModal(null)}
              >
                ×
              </button>
            </div>

            <label>
              Margin (Toman)

              <input
                type="number"
                min="1"
                value={margin}
                onChange={(event) =>
                  setMargin(event.target.value)
                }
                required
              />
            </label>

            <label>
              Leverage

              <select
                value={leverage}
                onChange={(event) =>
                  setLeverage(event.target.value)
                }
              >
                {[1, 2, 3, 5, 10, 20, 25, 50, 75, 100].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value}x
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              Stop Loss (optional)

              <input
                type="number"
                min="1"
                value={stopLoss}
                onChange={(event) =>
                  setStopLoss(event.target.value)
                }
                placeholder="Price in Toman"
              />
            </label>

            <label>
              Take Profit (optional)

              <input
                type="number"
                min="1"
                value={takeProfit}
                onChange={(event) =>
                  setTakeProfit(event.target.value)
                }
                placeholder="Price in Toman"
              />
            </label>

            <button
              type="submit"
              className={`confirm ${
                modal === "LONG"
                  ? "confirmLong"
                  : "confirmShort"
              }`}
            >
              Open {modal}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <App />
);

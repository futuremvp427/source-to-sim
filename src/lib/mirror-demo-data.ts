/**
 * DEMO / SAMPLE data. Used ONLY when the public Polymarket API is unreachable.
 * Always surfaced in the UI as DEMO — never presented as live.
 */

const NOW = 1786120000;

export const DEMO_RAW_TRADES = [
  {
    side: "BUY",
    asset: "demo-asset-1",
    conditionId: "0xdemo1",
    size: 120,
    price: 0.32,
    timestamp: NOW - 120,
    title: "DEMO: Will Team A win the championship?",
    outcome: "Yes",
    transactionHash: "0xdemotx1",
  },
  {
    side: "BUY",
    asset: "demo-asset-1",
    conditionId: "0xdemo1",
    size: 120,
    price: 0.32,
    timestamp: NOW - 120,
    title: "DEMO: Will Team A win the championship?",
    outcome: "Yes",
    transactionHash: "0xdemotx1",
  },
  {
    side: "SELL",
    asset: "demo-asset-1",
    conditionId: "0xdemo1",
    size: 240,
    price: 0.41,
    timestamp: NOW - 60,
    title: "DEMO: Will Team A win the championship?",
    outcome: "Yes",
    transactionHash: "0xdemotx2",
  },
  {
    side: "BUY",
    asset: "demo-asset-2",
    conditionId: "0xdemo2",
    size: 40,
    price: 0.18,
    timestamp: NOW - 30,
    title: "DEMO: Will the highest temperature in Toronto be 30C?",
    outcome: "Yes",
    transactionHash: "0xdemotx3",
  },
];

export const DEMO_RAW_POSITIONS = [
  {
    asset: "demo-asset-2",
    conditionId: "0xdemo2",
    title: "DEMO: Will the highest temperature in Toronto be 30C?",
    outcome: "Yes",
    size: 40,
    avgPrice: 0.18,
    curPrice: 0.22,
    currentValue: 8.8,
    realizedPnl: 0,
    cashPnl: 1.6,
    percentPnl: 22.2,
    redeemable: false,
    endDate: "2026-08-08",
  },
  {
    asset: "demo-asset-3",
    conditionId: "0xdemo3",
    title: "DEMO: Will inflation print above 3%?",
    outcome: "No",
    size: 0,
    avgPrice: 0.44,
    curPrice: 0,
    currentValue: 0,
    realizedPnl: 18.4,
    cashPnl: 18.4,
    percentPnl: 41.8,
    redeemable: true,
    endDate: "2026-07-15",
  },
];
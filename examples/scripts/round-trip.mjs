// The advanced track's demonstration: buy FEAST, then sell it two minutes later.
// It asks for 0.002 BNB; in the warm-up tier the runtime trades 0.001.

export const meta = { name: "round-trip", tickSeconds: 15 };

export function onTick(api) {
  const state = api.state;
  const held = api.read.position("FEAST");
  if (!state.bought && !held) {
    api.buy({ coin: "FEAST", bnb: 0.002, reason: "round trip: enter" });
    state.bought = api.read.now();
    return;
  }
  if (held && !state.sold && api.read.now() - state.bought >= 120000) {
    api.sell({ coin: "FEAST", fraction: 1, reason: "round trip: exit after two minutes" });
    state.sold = api.read.now();
  }
}

import assert from "node:assert/strict";
import { isFist, isWritingHand } from "../src/gesture.js";

const hand = (overrides = {}) => {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  points[0] = { x: 0.5, y: 0.84 };
  points[4] = { x: 0.33, y: 0.54 };
  points[5] = { x: 0.45, y: 0.62 };
  points[6] = { x: 0.43, y: 0.48 };
  points[8] = { x: 0.41, y: 0.24 };
  points[9] = { x: 0.52, y: 0.61 };
  points[12] = { x: 0.54, y: 0.32 };
  points[16] = { x: 0.62, y: 0.36 };
  points[17] = { x: 0.66, y: 0.66 };
  points[20] = { x: 0.72, y: 0.42 };
  Object.entries(overrides).forEach(([index, point]) => {
    points[Number(index)] = point;
  });
  return points;
};

assert.equal(isWritingHand(hand()), true, "open pointing hand should draw");

const casualPointing = hand({
  12: { x: 0.54, y: 0.55 },
  16: { x: 0.61, y: 0.58 },
  20: { x: 0.68, y: 0.6 }
});
assert.equal(isWritingHand(casualPointing), true, "index writing should not require other fingers folded");

const fist = hand({
  4: { x: 0.65, y: 0.68 },
  8: { x: 0.52, y: 0.66 },
  12: { x: 0.54, y: 0.65 },
  16: { x: 0.58, y: 0.66 },
  20: { x: 0.62, y: 0.67 }
});
assert.equal(isFist(fist), true, "closed hand should be a fist");
assert.equal(isWritingHand(fist), false, "fist should not draw");

console.log("Gesture classifier tests passed");

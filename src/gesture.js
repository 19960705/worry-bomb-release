export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const isFist = (landmarks) => {
  const wrist = landmarks[0];
  const middleBase = landmarks[9];
  const palm = Math.max(0.001, distance(wrist, middleBase));
  const tips = [8, 12, 16, 20].map((index) => landmarks[index]);
  const folded = tips.filter((tip) => distance(tip, wrist) / palm < 2.05).length;
  const thumbFold = distance(landmarks[4], landmarks[17]) / palm < 1.4;
  return folded >= 3 && thumbFold;
};

export const isWritingHand = (landmarks) => {
  if (isFist(landmarks)) {
    return false;
  }
  const wrist = landmarks[0];
  const indexBase = landmarks[5];
  const indexMiddle = landmarks[6];
  const indexTip = landmarks[8];
  const middleBase = landmarks[9];
  const palm = Math.max(0.001, distance(wrist, middleBase));

  const indexReach = distance(indexTip, indexBase) / palm;
  const indexAwayFromPalm = distance(indexTip, wrist) / palm;
  const indexBeyondMiddleJoint = distance(indexTip, indexBase) > distance(indexMiddle, indexBase) * 1.18;

  return indexReach > 0.82 || indexAwayFromPalm > 1.42 || indexBeyondMiddleJoint;
};

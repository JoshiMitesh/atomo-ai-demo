/**
 * Face recognition confidence — match score vs detection score (0–1).
 */

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return n / 100;
  if (n < 0) return null;
  return Math.min(1, n);
}

function pickPositiveScore(...values) {
  for (const v of values) {
    const n = clamp01(v);
    if (n != null && n > 0) return n;
  }
  return null;
}

function resolveFaceMatchScore(face) {
  // Board puts detection conf on `score` for unknowns — that is NOT a match score.
  if (face?.is_known && face?.match) {
    return pickPositiveScore(
      face?.match_score,
      face?.match?.score,
      face?.score,
    );
  }
  return pickPositiveScore(
    face?.match_score,
    face?.match?.score,
  );
}

function resolveFaceDetectionScore(face) {
  return pickPositiveScore(
    face?.detection_score,
    face?.detection_conf,
  );
}

function resolveFaceEventConfidence(face, isKnown) {
  const match = resolveFaceMatchScore(face);
  const detection = resolveFaceDetectionScore(face);
  if (isKnown) {
    return match ?? detection ?? 0.72;
  }
  // Unknown: show match attempt if close, else detection quality (not as fake "match %")
  return match ?? detection ?? 0.55;
}

function formatConfidencePercent(confidence, { isKnown = false } = {}) {
  let c = clamp01(confidence);
  if (c == null || c <= 0) {
    c = isKnown ? 0.72 : 0.55;
  }
  return Math.max(1, Math.min(100, Math.round(c * 100)));
}

function enrichFaceScores(face) {
  const matchScore = resolveFaceMatchScore(face);
  const detectionScore = resolveFaceDetectionScore(face);
  const isKnown = Boolean(face?.match?.name) || (face?.is_known && face?.match);
  return {
    ...face,
    is_known: isKnown,
    match_score: matchScore,
    detection_score: detectionScore ?? face?.detection_score ?? 0,
    display_confidence: resolveFaceEventConfidence(
      { ...face, match_score: matchScore, detection_score: detectionScore },
      isKnown,
    ),
  };
}

function repairFaceEvent(event) {
  if (event?.label !== 'face') return event;
  const match = pickPositiveScore(event.matchConfidence, event.confidence);
  const detection = pickPositiveScore(event.detectionConfidence);
  const isKnown = Boolean(event.isKnown);
  let confidence = clamp01(event.confidence);
  if (confidence == null || confidence <= 0) {
    confidence = match ?? detection ?? (isKnown ? 0.72 : 0.55);
  }
  return {
    ...event,
    confidence,
    matchConfidence: match ?? event.matchConfidence ?? null,
    detectionConfidence: detection ?? event.detectionConfidence ?? null,
  };
}

module.exports = {
  clamp01,
  resolveFaceMatchScore,
  resolveFaceDetectionScore,
  resolveFaceEventConfidence,
  formatConfidencePercent,
  enrichFaceScores,
  repairFaceEvent,
};

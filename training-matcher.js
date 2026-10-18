(function (root, factory) {
  const matcher = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = matcher;
  else root.matchTrainingLabels = matcher;
})(globalThis, function () {
  function normalize(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/20\d{2}년?/g, "")
      .replace(/[\s·ㆍ,，、.()（）\[\]{}:：;；_\-‐‑–—]/g, "");
  }

  function matchTrainingLabels(labels, trainings) {
    const matched = new Map();
    const add = (label, training) => {
      if (!training) return;
      if (!matched.has(training)) matched.set(training, new Set());
      matched.get(training).add(label);
    };
    const targets = [
      { source: ["부정청탁"], target: ["청탁금지법 교육", "청렴·부패방지 교육", "부패방지"] },
      { source: ["직장내장애인식"], target: ["장애인식 개선교육", "장애인식"] }
    ];

    for (const rawLabel of labels || []) {
      const label = String(rawLabel || "").trim();
      const key = normalize(label);
      if (!key) continue;

      const exact = trainings.find((training) => normalize(training) === key);
      if (exact) {
        add(label, exact);
        continue;
      }

      const direct = trainings
        .filter((training) => {
          const candidate = normalize(training);
          return candidate.length >= 4 && (candidate.includes(key) || key.includes(candidate));
        })
        .sort((a, b) => normalize(a).length - normalize(b).length)[0];
      if (direct) {
        add(label, direct);
        continue;
      }

      const rule = targets.find((item) => item.source.some((alias) => key.includes(normalize(alias))));
      if (rule) {
        let target;
        for (const hint of rule.target) {
          target = trainings.find((training) => normalize(training).includes(normalize(hint)));
          if (target) break;
        }
        if (target) add(label, target);
      }
    }

    return [...matched].map(([training, sources]) => ({ training, sources: [...sources] }));
  }

  return matchTrainingLabels;
});

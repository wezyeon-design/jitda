(function (root, factory) {
  const parse = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = parse;
  else root.parseCertificateText = parse;
})(globalThis, function () {
  function parseCertificateText(text) {
    const compact = String(text || "").normalize("NFKC").replace(/\s+/g, "");
    const listMatch = compact.match(/(?:법정의무교육|법정교육|법정의무연수)[(（]([^()（）]+)[)）]/);
    const readableCourseName = text.match(/연\s*수\s*명\s*[:：]?\s*([^()（）\n]+)/);
    let trainings = listMatch
      ? listMatch[1].split(/[,，、]/).map((name) => name.trim()).filter(Boolean)
      : readableCourseName
        ? [readableCourseName[1].trim()]
        : [...compact.matchAll(/(?:연수명|과정명)[:：]?([^()（）]+)/g)].map((match) => match[1].trim()).filter(Boolean);

    trainings = [...new Set(trainings)];
    const periodStart = compact.indexOf("연수기간");
    const dateArea = periodStart >= 0
      ? compact.slice(periodStart).split(/연수종류|연수목적|이수시간|성명/)[0]
      : compact;
    const dates = [...dateArea.matchAll(/(20\d{2})(?:년|[.\-/])(\d{1,2})(?:월|[.\-/])(\d{1,2})일?/g)];
    const date = dates.at(-1);

    return {
      trainings,
      completionDate: date ? `${date[1]}-${String(date[2]).padStart(2, "0")}-${String(date[3]).padStart(2, "0")}` : ""
    };
  }

  return parseCertificateText;
});

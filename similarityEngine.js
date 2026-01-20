// similarityEngine.js

let defaultAlgo = null;

// Load default algorithm JSON at runtime
async function loadDefaultAlgo() {
  if (defaultAlgo) return;
  try {
    const res = await fetch('./defaultAlgorithm.json');
    defaultAlgo = await res.json();
  } catch (err) {
    console.error("Failed to load defaultAlgorithm.json, using fallback defaults.", err);
    defaultAlgo = {
      weights: { area: 0.4, market: 0.2, land: 0.1, year: 0.3 },
      cutoffs: { areaPct: 0.1, marketPct: 0.2, landPct: 0.3, yearDiff: 10 },
      priceBias: { enabled: true, weight: 0.15, fullBiasAt: 50 }
    };
  }
}

// Helper: relative difference
function relDiff(a, b) {
  return Math.abs(a - b) / Math.max(a, b);
}

// Main function
export async function getSimilarProperties(options) {
  await loadDefaultAlgo(); // ensure defaultAlgo is loaded

  if (!options || !options.propid) throw new Error("propid is required in options");

  const BASE = "https://data.texas.gov/resource/nne4-8riu.json";
  const LIMIT = options.limit || 10;

  // Start with defaults
  let weights = defaultAlgo.weights;
  let cutoffs = defaultAlgo.cutoffs;
  let priceBias = defaultAlgo.priceBias;

  // Override with user-provided customAlgo (JSON object or string)
  if (options.customAlgo) {
    try {
      const algo = typeof options.customAlgo === "string"
        ? JSON.parse(options.customAlgo)
        : options.customAlgo;

      if (algo.weights) weights = { ...weights, ...algo.weights };
      if (algo.cutoffs) cutoffs = { ...cutoffs, ...algo.cutoffs };
      if (algo.priceBias) priceBias = { ...priceBias, ...algo.priceBias };
    } catch (err) {
      console.warn("Invalid custom algorithm JSON, using defaults.", err);
    }
  }

  // Step 1: Fetch target property
  const targetUrl = `${BASE}?$select=imprvmainarea,prevvalmarket,prevvalland,imprvyearbuilt,legalabssubcode` +
                    `&$where=propid='${options.propid}'`;
  const targetRes = await fetch(targetUrl);
  const targetData = await targetRes.json();
  if (!targetData.length) throw new Error("Target property not found");
  const t = targetData[0];
  const legal = t.legalabssubcode;

  // Step 2: Fetch candidates in same legalabssubcode
  const candidatesUrl = `${BASE}?$select=propid,imprvmainarea,prevvalmarket,prevvalland,imprvyearbuilt` +
                        `&$where=legalabssubcode='${legal}' AND propid!='${options.propid}'`;
  const candidatesRes = await fetch(candidatesUrl);
  const candidates = await candidatesRes.json();

  const availabilityFactor = priceBias.enabled
    ? Math.min(1, candidates.length / priceBias.fullBiasAt)
    : 0;

  // Step 3: Filter & score
  const scored = candidates
    .filter(r =>
      r.imprvmainarea && r.prevvalmarket && r.prevvalland && r.imprvyearbuilt &&
      relDiff(r.imprvmainarea, t.imprvmainarea) <= cutoffs.areaPct &&
      relDiff(r.prevvalmarket, t.prevvalmarket) <= cutoffs.marketPct &&
      relDiff(r.prevvalland, t.prevvalland) <= cutoffs.landPct &&
      Math.abs(r.imprvyearbuilt - t.imprvyearbuilt) <= cutoffs.yearDiff
    )
    .map(r => {
      const baseSimilarity =
        weights.area   * relDiff(r.imprvmainarea, t.imprvmainarea) +
        weights.market * relDiff(r.prevvalmarket, t.prevvalmarket) +
        weights.land   * relDiff(r.prevvalland, t.prevvalland) +
        weights.year   * (Math.abs(r.imprvyearbuilt - t.imprvyearbuilt) / 100);

      let priceBiasValue = 0;
      if (priceBias.enabled) {
        const priceRatio = r.prevvalmarket / t.prevvalmarket;
        priceBiasValue = Math.max(0, priceRatio - 1);
      }

      const similarity = baseSimilarity + availabilityFactor * priceBias.weight * priceBiasValue;

      return { ...r, similarity, baseSimilarity, priceBias: priceBiasValue };
    })
    .sort((a, b) => a.similarity - b.similarity)
    .slice(0, LIMIT);

  return {
    target: t,
    legalabssubcode: legal,
    totalCandidates: candidates.length,
    filteredCandidates: scored.length,
    comps: scored
  };
}

/**
 * Recover dropped ⟦Mn⟧ placeholders in ZH translations.
 * Shared by the reader (client) — no server-only imports.
 */

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function embedIndex(emb: { id?: string }, fallback: number): string {
  const id = emb.id || "";
  if (id.startsWith("m") && id.length > 1) return id.slice(1);
  if (/^\d+$/.test(id)) return id;
  return String(fallback);
}

export function sanitizeMathHtmlLite(html: string): string {
  if (!html) return html;
  let out = html;
  if (/<annotation\b/i.test(out)) {
    out = out
      .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gi, "")
      .replace(/<annotation-xml\b[^>]*>[\s\S]*?<\/annotation-xml>/gi, "");
  }
  if (/>\s*OPEN\s*</i.test(out) || />\s*CLOSE\s*</i.test(out)) {
    out = out
      .replace(/<mo\b[^>]*>\s*OPEN\s*<\/mo>/gi, "")
      .replace(/<mo\b[^>]*>\s*CLOSE\s*<\/mo>/gi, "");
  }
  return out;
}

export function mathPlainFromHtml(block: string): string {
  return sanitizeMathHtmlLite(block)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bOPEN\b|\bCLOSE\b/g, "")
    .trim();
}

export function mathTexFromHtml(block: string): string {
  const raw =
    /alttext="([^"]*)"/i.exec(block)?.[1] ||
    /application\/x-tex">([^<]*)</i.exec(block)?.[1] ||
    "";
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/** Collapse whitespace so "C ^ c ​ ( 𝐫 )" → "C^c​(𝐫)" (ZWSP kept). */
export function compactMathText(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Candidate strings the model may have written instead of ⟦Mn⟧. */
export function mathAliases(block: string): string[] {
  const tex = mathTexFromHtml(block);
  const plain = mathPlainFromHtml(block);
  const out: string[] = [];
  const add = (x: string) => {
    const t = (x || "").trim();
    if (!t) return;
    if (!out.includes(t)) out.push(t);
    const c = compactMathText(t);
    if (c && !out.includes(c)) out.push(c);
    // Also drop zero-width chars for another variant
    const c2 = c.replace(/[\u200b\u200c\u200d\ufeff]/g, "");
    if (c2 && !out.includes(c2)) out.push(c2);
  };
  add(tex);
  if (tex.startsWith("\\")) add(tex.slice(1));
  add(plain);
  return out.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * When the model drops ⟦Mn⟧ and writes raw math / TeX / “ci”+“c_{i}”, map
 * leftovers back to embed tokens (real embed ids, not 0..n-1).
 */
export function recoverZhEmbedTokens(
  zh: string,
  embeds: { id: string; html: string }[],
): string {
  if (!zh || !embeds.length) return zh;
  if (/⟦M\d+⟧/.test(zh)) return zh;

  const held: string[] = [];
  const maskTok = (token: string) => {
    const i = held.length;
    held.push(token);
    return `\uE010${i}\uE011`;
  };
  const maskExisting = (s: string) =>
    s.replace(/⟦M\d+⟧/g, (m) => maskTok(m));
  const unmaskAll = (s: string) =>
    s
      .replace(/\uE010(\d+)\uE011/g, (_, n) => held[Number(n)] || "")
      .replace(/\uE010|\uE011/g, "");

  let out = zh;

  const mathEmbeds = embeds
    .filter((e) => /<math\b/i.test(e.html || ""))
    .sort((a, b) => {
      const la = mathAliases(a.html || "")[0]?.length || 0;
      const lb = mathAliases(b.html || "")[0]?.length || 0;
      return lb - la;
    });

  for (const emb of mathEmbeds) {
    const num = embedIndex(emb, 0);
    const token = `⟦M${num}⟧`;
    if (out.includes(token)) continue;
    const aliases = mathAliases(emb.html || "");
    if (!aliases.length) continue;

    let work = maskExisting(out);
    let placed = false;

    type Cand = { re: RegExp; group: boolean };
    const candidates: Cand[] = [];

    // Prefer concatenated junk the model often emits: plain+tex / tex+plain
    for (let i = 0; i < aliases.length; i++) {
      for (let j = 0; j < aliases.length; j++) {
        if (i === j) continue;
        const a = aliases[i]!;
        const b = aliases[j]!;
        if (a.length < 1 || b.length < 1) continue;
        if (a.length === 1 && b.length === 1) continue;
        candidates.push({
          re: new RegExp(`${escapeRegExp(a)}\\s*${escapeRegExp(b)}`),
          group: false,
        });
      }
    }

    for (const a of aliases) {
      if (a.length === 1) {
        candidates.push({
          re: new RegExp(
            `(^|[^A-Za-z0-9\\uE010\\uE011])${escapeRegExp(a)}([^A-Za-z0-9\\uE010\\uE011]|$)`,
          ),
          group: true,
        });
      } else if (!/^\d+$/.test(a)) {
        candidates.push({ re: new RegExp(escapeRegExp(a)), group: false });
      }
      // Duplicated plain: "N N"
      if (a.length >= 1 && !/^\d+$/.test(a)) {
        candidates.push({
          re: new RegExp(
            `${escapeRegExp(a)}(?:\\s+${escapeRegExp(a)})+`,
          ),
          group: false,
        });
      }
    }

    for (const { re, group } of candidates) {
      if (!re.test(work)) continue;
      work = group ? work.replace(re, `$1${token}$2`) : work.replace(re, token);
      placed = true;
      break;
    }
    if (!placed) continue;

    work = work.replaceAll(token, maskTok(token));
    const lastMask = `\uE010${held.length - 1}\uE011`;

    // Scrub leftover aliases glued to the placed token (any length).
    // Allow optional ZWSP between chars — models often keep/drop \u200b unevenly.
    for (const a of aliases) {
      if (!a || /^\d+$/.test(a)) continue;
      const mask = escapeRegExp(lastMask);
      const variants = [escapeRegExp(a)];
      if (a.length > 1 && a.length < 40) {
        variants.push([...a].map((ch) => escapeRegExp(ch)).join("\\u200b?"));
      }
      for (const esc of variants) {
        work = work
          .replace(new RegExp(`${esc}\\s*${mask}`, "g"), lastMask)
          .replace(new RegExp(`${mask}\\s*${esc}`, "g"), lastMask);
      }
    }

    out = unmaskAll(work);
  }

  // Link embeds — never match bare numbers alone.
  const linkEmbeds = embeds.filter((e) => /<a\b/i.test(e.html || ""));
  for (const emb of linkEmbeds) {
    const num = embedIndex(emb, 0);
    const token = `⟦M${num}⟧`;
    if (out.includes(token)) continue;
    const block = emb.html || "";
    const plain = mathPlainFromHtml(block);
    const href = /href=["']([^"']+)["']/i.exec(block)?.[1] || "";
    let work = maskExisting(out);
    let placed = false;

    const fig =
      /(?:Fig\.?|Figure|Tab\.?|Table)\s*(\d+)/i.exec(plain) ||
      /(?:Fig\.?|Figure|Tab\.?|Table)\s*(\d+)/i.exec(block);
    if (fig) {
      const n = fig[1];
      const isTab = /tab/i.test(fig[0]);
      const zhRef = new RegExp(
        `(?:${isTab ? "表" : "图"}|${isTab ? "Table|Tab\\.?" : "Fig\\.?|Figure"})\\s*${n}`,
        "i",
      );
      if (zhRef.test(work)) {
        work = work.replace(zhRef, token);
        placed = true;
      }
    }

    const alg =
      /(?:Algorithm|Alg\.?)\s*(\d+)/i.exec(plain) ||
      /(?:Algorithm|Alg\.?)\s*(\d+)/i.exec(block);
    if (!placed && alg && !/\.l\d+/i.test(href)) {
      const n = alg[1];
      const zhAlg = new RegExp(`(?:算法|Algorithm|Alg\\.?)\\s*${n}`, "i");
      if (zhAlg.test(work)) {
        work = work.replace(zhAlg, token);
        placed = true;
      }
    }

    const lineHref = /\.l(\d+)\b/i.exec(href);
    const linePlain = /^(?:line\s*)?(\d+)$/i.exec(plain.trim());
    if (!placed && (lineHref || linePlain)) {
      const n = lineHref?.[1] || linePlain?.[1] || "";
      if (n) {
        const zhLine = new RegExp(`(第\\s*)${n}(\\s*行)`);
        if (zhLine.test(work)) {
          work = work.replace(zhLine, `$1${token}$2`);
          placed = true;
        }
      }
    }

    // Eqn. N / 公式 N / Equation N (plain may be just "3" for eq links)
    if (!placed) {
      const eqnLabel =
        /(?:Eqn?\.?|Equation)\s*(\d+)/i.exec(plain) ||
        /(?:Eqn?\.?|Equation)\s*(\d+)/i.exec(block);
      const n = eqnLabel?.[1] || (/^\d+$/.test(plain.trim()) ? plain.trim() : "");
      if (n) {
        const zhEq = new RegExp(
          `(?:公式|方程式|Eqn?\\.?|Equation)\\s*${n}`,
          "i",
        );
        if (zhEq.test(work)) {
          work = work.replace(zhEq, token);
          placed = true;
        }
      }
    }

    if (!placed) continue;
    work = work.replaceAll(token, maskTok(token));
    out = unmaskAll(work);
  }

  return unmaskAll(out).replace(/[ \t]{2,}/g, " ").trim();
}

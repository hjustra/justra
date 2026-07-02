(function justraPjeCaptureContent() {
  if (window.__justraPjeCaptureLoaded) {
    window.dispatchEvent(new CustomEvent("justra:pje:open"));
    return;
  }
  window.__justraPjeCaptureLoaded = true;

  const PROCESS_FORMATTED_RE = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
  const PROCESS_COMPACT_RE = /(?<!\d)(\d{20})(?!\d)/;
  const BR_DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?\b/;
  const MAX_TEXT_CHARS = 90000;
  const MAX_DOCUMENT_TEXT_CHARS = 180000;
  const MAX_MOVEMENTS = 80;
  const MAX_DOCUMENTS = 160;
  const MAX_AUTOMATED_DOCUMENTS = 80;
  const DOCUMENT_OPEN_TIMEOUT_MS = 4500;
  const DOCUMENT_OPEN_POLL_MS = 250;
  const FRAME_CAPTURE_TIMEOUT_MS = 900;
  const FRAME_REQUEST_TYPE = "JUSTRA_COLLECT_OPEN_DOCUMENT";
  const FRAME_RESPONSE_TYPE = "JUSTRA_OPEN_DOCUMENT_RESPONSE";
  const DOCUMENT_ITEM_RE = /\b(Senten[çc]a|Decis[ãa]o|Despacho|Ac[óo]rd[ãa]o|Ata(?:\s+de\s+audi[êe]ncia)?|Peti[çc][ãa]o|Certid[ãa]o|Intima[çc][ãa]o|Notifica[çc][ãa]o|Alvar[áa]|Mandado|Of[íi]cio|Termo|C[áa]lculo|Laudo|Manifesta[çc][ãa]o|Recurso|Contrarraz[õo]es|Embargos|Contesta[çc][ãa]o|Inicial)\s*(?:\([^)]{1,100}\))?\s*[-–—]\s*([a-f0-9]{6,40})\b/gi;
  const TEST_URL = "https://pje.trt2.jus.br/consultaprocessual/detalhe-processo/1000717-52.2024.5.02.0202/1#589702a";

  let lastPayload = null;
  let root = null;
  let panel = null;
  let launcher = null;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function compactSpaces(value) {
    return normalizeText(value).replace(/\s+/g, " ").trim();
  }

  function onlyDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function formatCnj(digits) {
    if (!/^\d{20}$/.test(digits)) {
      return "";
    }
    return `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16, 20)}`;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractProcessNumber(text) {
    const source = String(text || "");
    const formatted = source.match(PROCESS_FORMATTED_RE);
    if (formatted) {
      return formatted[0];
    }
    const compact = source.match(PROCESS_COMPACT_RE);
    return compact ? formatCnj(compact[1]) : "";
  }

  function getVisibleText() {
    return normalizeText(document.body ? document.body.innerText : "");
  }

  function cleanPageTextForCaseFields(text) {
    const lines = String(text || "")
      .split(/\n+/)
      .map((line) => compactSpaces(line))
      .filter(Boolean);
    const stopIndex = lines.findIndex((line) => /^Documentos do processo$/i.test(line));
    return (stopIndex >= 0 ? lines.slice(0, stopIndex) : lines.slice(0, 60)).join("\n");
  }

  function extractCourtUnit(text) {
    const head = cleanPageTextForCaseFields(text);
    const withProcessHeader = head.match(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\s*\(([^)]+)\)/);
    if (withProcessHeader && withProcessHeader[1]) {
      return cleanFieldValue(withProcessHeader[1]);
    }
    const firstVara = head.match(/\b(\d+[ªa]?\s+Vara do Trabalho de [^\n()]{2,120})/i);
    if (firstVara && firstVara[1]) {
      return cleanFieldValue(firstVara[1]);
    }
    return "";
  }

  function extractCaseClass(text) {
    const head = cleanPageTextForCaseFields(text);
    const match = head.match(/\b([A-Z][A-Za-z]{2,10})\s+\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/);
    return match ? match[1] : "";
  }

  function firstLabelValue(text, labels) {
    const lines = String(text || "")
      .split(/\n+/)
      .map((line) => compactSpaces(line))
      .filter(Boolean);

    for (const label of labels) {
      const sameLine = new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "i");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const sameLineMatch = line.match(sameLine);
        if (sameLineMatch && sameLineMatch[1]) {
          return cleanFieldValue(sameLineMatch[1]);
        }
        if (line.toLowerCase() === label.toLowerCase()) {
          const next = lines[index + 1] || "";
          if (next) {
            return cleanFieldValue(next);
          }
        }
      }
    }

    const compact = compactSpaces(text);
    for (const label of labels) {
      const inline = new RegExp(`${escapeRegExp(label)}\\s*:?\\s*([^\\n\\r]{2,240})`, "i");
      const match = compact.match(inline);
      if (match && match[1]) {
        return cleanFieldValue(match[1]);
      }
    }
    return "";
  }

  function cleanFieldValue(value) {
    return compactSpaces(value)
      .replace(/^[-:;]+/, "")
      .replace(/[-:;]+$/, "")
      .slice(0, 240);
  }

  function parseBrDateMillis(value) {
    const match = String(value || "").match(BR_DATE_RE);
    if (!match) {
      return 0;
    }
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const hour = Number(match[4] || "0");
    const minute = Number(match[5] || "0");
    return Date.UTC(year, month - 1, day, hour, minute);
  }

  function looksLikeMovement(text) {
    const value = compactSpaces(text);
    if (value.length < 12 || value.length > 900) {
      return false;
    }
    if (BR_DATE_RE.test(value)) {
      return true;
    }
    return /\b(movimenta[cç][aã]o|juntada|remessa|conclusos|distribui[cç][aã]o|intima[cç][aã]o|pauta|audi[eê]ncia|senten[cç]a|ac[oó]rd[aã]o|despacho|decis[aã]o)\b/i.test(value);
  }

  function collectTableMovements() {
    const rows = [];
    document.querySelectorAll("tr").forEach((row) => {
      const cells = Array.from(row.cells || [])
        .map((cell) => compactSpaces(cell.innerText))
        .filter(Boolean);
      const text = cells.join(" · ");
      if (looksLikeMovement(text)) {
        rows.push({ text, source: "table" });
      }
    });
    return rows;
  }

  function collectElementMovements() {
    const selectors = [
      "li",
      "article",
      "[role='row']",
      "[class*='timeline']",
      "[class*='moviment']",
      "[class*='andament']",
      "[class*='evento']"
    ];
    const elements = new Set();
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => elements.add(element));
    });
    const rows = [];
    elements.forEach((element) => {
      const text = compactSpaces(element.innerText || element.textContent || "");
      if (looksLikeMovement(text)) {
        rows.push({ text, source: "element" });
      }
    });
    return rows;
  }

  function collectTextMovements(text) {
    const lines = String(text || "")
      .split(/\n+/)
      .map((line) => compactSpaces(line))
      .filter(Boolean);
    const rows = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!BR_DATE_RE.test(line)) {
        continue;
      }
      const next = lines[index + 1] || "";
      const after = lines[index + 2] || "";
      const textBlock = compactSpaces([line, next, after].filter(Boolean).join(" · "));
      if (looksLikeMovement(textBlock)) {
        rows.push({ text: textBlock, source: "text" });
      }
    }
    return rows;
  }

  function collectMovements(text) {
    const seen = new Set();
    const rows = [
      ...collectTableMovements(),
      ...collectElementMovements(),
      ...collectTextMovements(text)
    ];
    const deduped = [];
    rows.forEach((row) => {
      const textValue = compactSpaces(row.text);
      const key = textValue.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push({
          id: `pje-movement-${deduped.length + 1}`,
          text: textValue,
          date_text: (textValue.match(BR_DATE_RE) || [""])[0],
          sort_time: parseBrDateMillis(textValue),
          source: row.source
        });
      }
    });

    deduped.sort((left, right) => {
      if (right.sort_time !== left.sort_time) {
        return right.sort_time - left.sort_time;
      }
      return 0;
    });

    return deduped.slice(0, MAX_MOVEMENTS).map(({ sort_time: _sortTime, ...row }) => row);
  }

  function collectAttachments() {
    const seen = new Set();
    const attachments = [];
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.href || "";
      const label = compactSpaces(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "");
      const looksRelevant = /documento|download|autos|integra|pdf|arquivo|anexo|expediente/i.test(`${href} ${label}`);
      if (!href || !looksRelevant || seen.has(href)) {
        return;
      }
      seen.add(href);
      attachments.push({
        label: label.slice(0, 180) || "Documento do PJe",
        href,
        kind: /\.pdf(?:$|[?#])/i.test(href) || /pdf/i.test(label) ? "pdf_or_document" : "link"
      });
    });
    return attachments.slice(0, 50);
  }

  function hasCaptcha(text) {
    const value = String(text || "");
    if (/captcha|recaptcha|hcaptcha|n[aã]o sou um rob[oô]/i.test(value)) {
      return true;
    }
    return Boolean(document.querySelector("iframe[src*='captcha'], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, [data-sitekey]"));
  }

  function extractDegreeFromUrl(url) {
    const match = String(url || "").match(/\/detalhe-processo\/[^/]+\/(\d+)/);
    return match ? match[1] : "";
  }

  function isVisibleElement(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  }

  function stripCaptureUiText(text) {
    return normalizeText(
      String(text || "")
        .split(/\n+/)
        .filter((line) => !/^Captura PJe$|^Capturar página$|^Capturar doc\. aberto$|^Enviar para Justra$|^Baixar JSON$|^Copiar resumo$|^Justra$|^Voltar para a listagem$/i.test(compactSpaces(line)))
        .join("\n")
    );
  }

  function documentScore(text) {
    const value = compactSpaces(text);
    if (value.length < 240) {
      return 0;
    }
    let score = 0;
    if (value.length > 800) {
      score += 1;
    }
    if (value.length > 2000) {
      score += 1;
    }
    if (/\b(PODER JUDICI[ÁA]RIO|JUSTI[ÇC]A DO TRABALHO|TRIBUNAL REGIONAL DO TRABALHO|VARA DO TRABALHO)\b/i.test(value)) {
      score += 3;
    }
    if (/\b(SENTEN[ÇC]A|DECIS[ÃA]O|DESPACHO|AC[ÓO]RD[ÃA]O|ATA DE AUDI[ÊE]NCIA)\b/i.test(value)) {
      score += 2;
    }
    if (/\b(RELAT[ÓO]RIO|FUNDAMENTA[ÇC][ÃA]O|DISPOSITIVO|DECIDO|JULGO|VISTOS|CONCLUS[ÃA]O)\b/i.test(value)) {
      score += 2;
    }
    if (/Assinado eletronicamente|Documento assinado|Certid[aã]o de publica[cç][aã]o/i.test(value)) {
      score += 2;
    }
    const movementMarkers = (value.match(/\b(Juntada|Publicado|Disponibilizado|Expedido|Decorrido|Conclusos|Remetidos)\b/gi) || []).length;
    if (movementMarkers > 12 && !/\b(PODER JUDICI[ÁA]RIO|RELAT[ÓO]RIO|FUNDAMENTA[ÇC][ÃA]O|DISPOSITIVO|DECIDO)\b/i.test(value)) {
      score -= 3;
    }
    return score;
  }

  function detectDocumentType(text, title) {
    const value = `${title || ""}\n${text || ""}`;
    const options = [
      ["sentenca", /\bSenten[çc]a\b/i],
      ["decisao", /\bDecis[ãa]o\b/i],
      ["despacho", /\bDespacho\b/i],
      ["acordao", /\bAc[óo]rd[ãa]o\b/i],
      ["ata", /\bAta de audi[êe]ncia\b/i],
      ["peticao", /\bPeti[çc][ãa]o\b/i],
      ["certidao", /\bCertid[ãa]o\b/i],
      ["intimacao", /\bIntima[çc][ãa]o\b/i]
    ];
    const match = options.find(([, pattern]) => pattern.test(value));
    return match ? match[0] : "documento";
  }

  function extractDocumentCode(text, url) {
    const textSource = String(text || "");
    const explicitId = textSource.match(/\bId\s+([a-f0-9]{6,40})\b/i);
    if (explicitId) {
      return normalizeDocumentCode(explicitId[1]);
    }
    const marker = textSource.match(/\b(?:Senten[çc]a|Decis[ãa]o|Despacho|Ac[óo]rd[ãa]o|Ata(?:\s+de\s+audi[êe]ncia)?|Peti[çc][ãa]o|Certid[ãa]o|Intima[çc][ãa]o|Notifica[çc][ãa]o|Alvar[áa]|Mandado|Of[íi]cio|Termo|C[áa]lculo|Laudo|Manifesta[çc][ãa]o|Recurso|Contrarraz[õo]es|Embargos|Contesta[çc][ãa]o|Inicial)\s*(?:\([^)]{1,100}\))?\s*[-–—]\s*([a-f0-9]{6,40})\b/i);
    if (marker) {
      return normalizeDocumentCode(marker[1]);
    }
    const hash = String(url || "").match(/#([a-f0-9]{6,40})\b/i);
    return hash ? normalizeDocumentCode(hash[1]) : "";
  }

  function normalizeDocumentCode(value) {
    const match = String(value || "").match(/[a-f0-9]{6,40}/i);
    return match ? match[0].toLowerCase() : "";
  }

  function documentItemMatches(text) {
    const value = compactSpaces(text);
    const matches = [];
    DOCUMENT_ITEM_RE.lastIndex = 0;
    for (const match of value.matchAll(DOCUMENT_ITEM_RE)) {
      matches.push({
        type_label: cleanFieldValue(match[1] || "Documento"),
        code: normalizeDocumentCode(match[2] || ""),
        title: cleanFieldValue(match[0] || "")
      });
    }
    return matches;
  }

  function looksLikeDocumentDownloadControl(text) {
    return /baixar\s+certid[aã]o|certid[aã]o\s+de\s+juntada|baixar\s+arquivo|download/i.test(text || "");
  }

  function documentCandidateTitle(match, text) {
    const value = compactSpaces(text);
    if (value.length <= 180) {
      return value || match.title;
    }
    const codeIndex = match.code ? value.toLowerCase().indexOf(match.code.toLowerCase()) : -1;
    if (codeIndex >= 0) {
      return cleanFieldValue(value.slice(Math.max(0, codeIndex - 90), Math.min(value.length, codeIndex + 90)));
    }
    return match.title;
  }

  function findDocumentClickTarget(element, code) {
    const selectors = "a, button, [role='button'], [onclick], [tabindex]";
    const candidates = [element, ...Array.from(element.querySelectorAll ? element.querySelectorAll(selectors) : [])];
    const matchingChild = candidates
      .filter((candidate) => candidate instanceof Element && !candidate.closest(".justra-pje-root") && isVisibleElement(candidate))
      .sort((left, right) => compactSpaces(left.innerText || left.textContent || "").length - compactSpaces(right.innerText || right.textContent || "").length)
      .find((candidate) => !code || compactSpaces(candidate.innerText || candidate.textContent || "").toLowerCase().includes(code.toLowerCase()));
    if (matchingChild) {
      return matchingChild;
    }
    const clickableAncestor = element.closest ? element.closest(selectors) : null;
    if (clickableAncestor && !clickableAncestor.closest(".justra-pje-root") && isVisibleElement(clickableAncestor)) {
      return clickableAncestor;
    }
    return element;
  }

  function collectDocumentOpeners() {
    const selector = [
      "a",
      "button",
      "[role='button']",
      "[onclick]",
      "[tabindex]",
      "li",
      "tr",
      "[class*='timeline']",
      "[class*='moviment']",
      "[class*='andament']",
      "[class*='evento']",
      "[class*='documento']",
      "[id*='documento']"
    ].join(",");
    const rows = [];
    const seen = new Set();
    Array.from(document.querySelectorAll(selector)).forEach((element) => {
      if (!isVisibleElement(element) || element.closest(".justra-pje-root")) {
        return;
      }
      const text = compactSpaces(element.innerText || element.textContent || "");
      if (!text || text.length > 900 || looksLikeDocumentDownloadControl(text)) {
        return;
      }
      documentItemMatches(text).forEach((match) => {
        if (!match.code || seen.has(match.code)) {
          return;
        }
        const target = findDocumentClickTarget(element, match.code);
        seen.add(match.code);
        rows.push({
          code: match.code,
          title: documentCandidateTitle(match, text),
          type_label: match.type_label,
          text,
          target
        });
      });
    });
    return rows.slice(0, MAX_AUTOMATED_DOCUMENTS);
  }

  function titleFromDocumentText(text, fallback = "") {
    const lines = String(text || "")
      .split(/\n+/)
      .map((line) => compactSpaces(line))
      .filter(Boolean);
    const explicit = lines.find((line) => /\b(Senten[çc]a|Decis[ãa]o|Despacho|Ac[óo]rd[ãa]o|Ata|Certid[ãa]o|Intima[çc][ãa]o|Peti[çc][ãa]o)\b/i.test(line) && line.length <= 180);
    if (explicit) {
      return explicit;
    }
    const heading = lines.find((line) => line.length >= 6 && line.length <= 160 && !BR_DATE_RE.test(line));
    return heading || fallback || document.title || "Documento PJe";
  }

  function documentFromText(text, source) {
    const contentText = stripCaptureUiText(text).slice(0, MAX_DOCUMENT_TEXT_CHARS);
    const score = documentScore(contentText);
    if (score < 4) {
      return null;
    }
    const title = titleFromDocumentText(contentText, source.title);
    return {
      id: `pje-document-${source.index || 1}`,
      title,
      document_type: detectDocumentType(contentText, title),
      document_code: extractDocumentCode(`${title}\n${contentText}`, source.url || location.href),
      captured_at: new Date().toISOString(),
      source: source.source || "top",
      source_url: source.url || location.href,
      frame_url: source.frame_url || "",
      extraction_method: source.method || "dom-visible-text",
      confidence_score: score,
      text_length: contentText.length,
      content_text: contentText
    };
  }

  function collectDocumentTextCandidates() {
    const selectors = [
      "[role='dialog']",
      ".modal",
      ".modal-content",
      ".cdk-overlay-pane",
      ".mat-dialog-container",
      ".p-dialog",
      ".ui-dialog",
      "article",
      "main",
      "[class*='documento']",
      "[class*='Documento']",
      "[id*='documento']",
      "[id*='Documento']",
      "[class*='inteiro']",
      "[id*='inteiro']",
      "[class*='visualizador']",
      "[id*='visualizador']"
    ];
    const elements = new Set();
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        if (!element.closest(".justra-pje-root") && isVisibleElement(element)) {
          elements.add(element);
        }
      });
    });
    const candidates = [];
    elements.forEach((element) => {
      const text = stripCaptureUiText(element.innerText || element.textContent || "");
      if (text) {
        candidates.push({ text, source: "top", method: "element-visible-text", title: element.getAttribute("aria-label") || "" });
      }
    });
    const bodyText = stripCaptureUiText(getVisibleText());
    const hasElementDocument = candidates.some((candidate) => documentScore(candidate.text) >= 4);
    if (!hasElementDocument && documentScore(bodyText) >= 4) {
      candidates.push({ text: bodyText, source: "top", method: "body-visible-text", title: document.title || "" });
    }
    return candidates;
  }

  function dedupeDocuments(documents) {
    const deduped = [];
    const sorted = documents
      .filter(Boolean)
      .sort((left, right) => {
        if ((right.confidence_score || 0) !== (left.confidence_score || 0)) {
          return (right.confidence_score || 0) - (left.confidence_score || 0);
        }
        return (right.text_length || 0) - (left.text_length || 0);
      });
    sorted.forEach((documentRow) => {
      const currentText = compactSpaces(documentRow.content_text || "");
      const duplicateIndex = deduped.findIndex((existing) => {
        const existingText = compactSpaces(existing.content_text || "");
        const sameCode = documentRow.document_code && existing.document_code && documentRow.document_code === existing.document_code;
        const sameSource = documentRow.source_url && existing.source_url && documentRow.source_url === existing.source_url;
        const sameTitle = compactSpaces(documentRow.title || "").toLowerCase() === compactSpaces(existing.title || "").toLowerCase();
        const shorter = currentText.length <= existingText.length ? currentText : existingText;
        const longer = currentText.length <= existingText.length ? existingText : currentText;
        const overlappingText = shorter.length > 280 && longer.includes(shorter.slice(0, Math.min(shorter.length, 1200)));
        return (sameCode && overlappingText) || (sameSource && sameTitle) || (sameSource && overlappingText && documentRow.document_type === existing.document_type);
      });
      if (duplicateIndex >= 0) {
        const existing = deduped[duplicateIndex];
        const betterScore = (documentRow.confidence_score || 0) > (existing.confidence_score || 0);
        const sameScoreLonger = (documentRow.confidence_score || 0) === (existing.confidence_score || 0) && (documentRow.text_length || 0) > (existing.text_length || 0);
        if (betterScore || sameScoreLonger) {
          deduped[duplicateIndex] = { ...documentRow, id: existing.id };
        }
      } else {
        deduped.push({ ...documentRow, id: `pje-document-${deduped.length + 1}` });
      }
    });
    return deduped.slice(0, MAX_DOCUMENTS);
  }

  function collectOpenDocumentsSync() {
    const documents = collectDocumentTextCandidates()
      .map((candidate, index) => documentFromText(candidate.text, { ...candidate, index: index + 1, url: location.href }));
    return dedupeDocuments(documents);
  }

  function collectEmbeddedDocumentRefs() {
    const refs = [];
    const seen = new Set();
    const addRef = (element, rawUrl, kind) => {
      const url = String(rawUrl || "").trim();
      if (!url || seen.has(url)) {
        return;
      }
      seen.add(url);
      refs.push({
        kind,
        url,
        title: compactSpaces(element.getAttribute("title") || element.getAttribute("aria-label") || element.name || ""),
        visible: isVisibleElement(element)
      });
    };
    document.querySelectorAll("iframe[src]").forEach((element) => addRef(element, element.src, "iframe"));
    document.querySelectorAll("embed[src]").forEach((element) => addRef(element, element.src, "embed"));
    document.querySelectorAll("object[data]").forEach((element) => addRef(element, element.data, "object"));
    return refs.slice(0, 30);
  }

  function installFrameCaptureBridge() {
    window.addEventListener("message", (event) => {
      if (!event.data || event.data.type !== FRAME_REQUEST_TYPE) {
        return;
      }
      if (!event.source || typeof event.source.postMessage !== "function") {
        return;
      }
      const documents = collectOpenDocumentsSync().map((documentRow) => ({
        ...documentRow,
        source: "iframe",
        frame_url: location.href,
        source_url: location.href
      }));
      const refs = collectEmbeddedDocumentRefs();
      event.source.postMessage(
        {
          type: FRAME_RESPONSE_TYPE,
          request_id: event.data.request_id,
          documents,
          document_refs: refs,
          frame_url: location.href,
          text_length: getVisibleText().length
        },
        event.origin || "*"
      );
    });
  }

  function collectFrameDocuments() {
    const frames = Array.from(document.querySelectorAll("iframe")).filter(isVisibleElement);
    if (!frames.length) {
      return Promise.resolve({ documents: [], document_refs: [] });
    }
    const requestId = `justra-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const documents = [];
      const documentRefs = [];
      const listener = (event) => {
        if (!event.data || event.data.type !== FRAME_RESPONSE_TYPE || event.data.request_id !== requestId) {
          return;
        }
        if (Array.isArray(event.data.documents)) {
          documents.push(...event.data.documents);
        }
        if (Array.isArray(event.data.document_refs)) {
          documentRefs.push(...event.data.document_refs);
        }
      };
      window.addEventListener("message", listener);
      frames.forEach((frame) => {
        try {
          frame.contentWindow.postMessage({ type: FRAME_REQUEST_TYPE, request_id: requestId }, "*");
        } catch (_error) {
          // Cross-origin frames still accept postMessage in most PJe viewers; ignore failures.
        }
      });
      window.setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve({ documents: dedupeDocuments(documents), document_refs: documentRefs.slice(0, 30) });
      }, FRAME_CAPTURE_TIMEOUT_MS);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function dedupeDocumentRefs(refs) {
    const seen = new Set();
    return refs.filter((ref) => {
      const key = `${ref.kind || ""}|${ref.url || ""}|${ref.title || ""}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  async function collectCurrentDocumentsAsync() {
    const frameCapture = await collectFrameDocuments();
    return {
      documents: dedupeDocuments([...collectOpenDocumentsSync(), ...frameCapture.documents]),
      document_refs: dedupeDocumentRefs([...collectEmbeddedDocumentRefs(), ...frameCapture.document_refs])
    };
  }

  function documentMatchesCandidate(documentRow, candidate) {
    const documentCode = normalizeDocumentCode(documentRow.document_code);
    if (candidate.code && documentCode) {
      return documentCode === candidate.code;
    }
    const text = `${documentRow.title || ""}\n${documentRow.content_text || ""}`;
    return Boolean(candidate.code && new RegExp(`\\b${escapeRegExp(candidate.code)}\\b`, "i").test(text));
  }

  function annotateCandidateDocument(documentRow, candidate) {
    return {
      ...documentRow,
      document_code: normalizeDocumentCode(documentRow.document_code || candidate.code),
      opener_title: candidate.title,
      opener_type_label: candidate.type_label,
      opened_from_timeline: true
    };
  }

  async function waitForCandidateDocument(candidate) {
    const startedAt = Date.now();
    let latestDocuments = [];
    while (Date.now() - startedAt < DOCUMENT_OPEN_TIMEOUT_MS) {
      latestDocuments = collectOpenDocumentsSync();
      const matching = latestDocuments.filter((documentRow) => documentMatchesCandidate(documentRow, candidate));
      if (matching.length) {
        return matching;
      }
      await sleep(DOCUMENT_OPEN_POLL_MS);
    }
    return latestDocuments.filter((documentRow) => documentMatchesCandidate(documentRow, candidate));
  }

  async function navigateToCandidateHash(candidate) {
    if (!candidate.code) {
      return false;
    }
    const oldUrl = location.href;
    const nextHash = `#${candidate.code}`;
    if (location.hash.toLowerCase() !== nextHash.toLowerCase()) {
      location.hash = candidate.code;
    } else {
      window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: oldUrl, newURL: location.href }));
    }
    await sleep(450);
    return true;
  }

  function clickDocumentTarget(target) {
    if (!target || !(target instanceof Element)) {
      return false;
    }
    const rect = target.getBoundingClientRect();
    const x = Math.max(0, rect.left + rect.width / 2);
    const y = Math.max(0, rect.top + Math.min(rect.height / 2, 24));
    const eventOptions = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((eventName) => {
      try {
        const EventClass = eventName.startsWith("pointer") && "PointerEvent" in window ? PointerEvent : MouseEvent;
        target.dispatchEvent(new EventClass(eventName, eventOptions));
      } catch (_error) {
        target.dispatchEvent(new MouseEvent(eventName, eventOptions));
      }
    });
    if (typeof target.click === "function") {
      target.click();
    }
    return true;
  }

  async function clickCandidateTarget(candidate) {
    try {
      candidate.target.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(80);
      clickDocumentTarget(candidate.target);
    } catch (error) {
      return error.message;
    }
    return "";
  }

  async function openAndCaptureDocumentCandidate(candidate) {
    await navigateToCandidateHash(candidate);
    let topDocuments = await waitForCandidateDocument(candidate);
    if (!topDocuments.length) {
      const clickError = await clickCandidateTarget(candidate);
      topDocuments = await waitForCandidateDocument(candidate);
      if (!topDocuments.length && clickError) {
        return { ok: false, error: clickError, documents: [], document_refs: [] };
      }
    }

    const frameCapture = await collectFrameDocuments();
    const allDocuments = dedupeDocuments([...topDocuments, ...frameCapture.documents])
      .filter((documentRow) => documentMatchesCandidate(documentRow, candidate))
      .map((documentRow) => annotateCandidateDocument(documentRow, candidate));
    return {
      ok: Boolean(allDocuments.length),
      error: allDocuments.length ? "" : "documento não apareceu no visualizador",
      documents: allDocuments,
      document_refs: frameCapture.document_refs
    };
  }

  function updatePartiesFromDocuments(payload) {
    const fieldText = [
      payload.raw?.visible_text || "",
      ...(payload.documents || []).map((documentRow) => String(documentRow.content_text || "").slice(0, 12000))
    ].join("\n");
    const claimant = firstLabelValue(fieldText, ["Reclamante", "Autor", "Autora", "Exequente", "Agravante", "Polo ativo"]);
    const defendant = firstLabelValue(fieldText, ["Reclamado", "Reclamada", "Réu", "Ré", "Executado", "Executada", "Agravado", "Agravada", "Polo passivo"]);
    const intimated = firstLabelValue(fieldText, ["Parte intimada", "Destinatário", "Destinatario", "Intimado", "Intimada"]);
    payload.parties = {
      ...payload.parties,
      claimant: claimant || payload.parties.claimant || "",
      defendant: defendant || payload.parties.defendant || "",
      intimated: intimated || payload.parties.intimated || ""
    };
  }

  async function buildPayloadWithOpenDocuments() {
    const payload = buildPayload();
    const frameCapture = await collectCurrentDocumentsAsync();
    payload.documents = dedupeDocuments([...(payload.documents || []), ...frameCapture.documents]);
    payload.document_refs = [...(payload.document_refs || []), ...frameCapture.document_refs].slice(0, 30);
    updatePartiesFromDocuments(payload);
    payload.diagnostics.open_document_count = payload.documents.length;
    payload.diagnostics.document_ref_count = payload.document_refs.length;
    lastPayload = payload;
    return payload;
  }

  async function buildPayloadWithAllVisibleDocuments(onProgress = () => {}) {
    const payload = buildPayload();
    const openers = collectDocumentOpeners();
    const candidateRows = openers.map((candidate) => ({
      code: candidate.code,
      title: candidate.title,
      type_label: candidate.type_label,
      captured: false,
      error: ""
    }));
    const collectedDocuments = [...(payload.documents || [])];
    let collectedRefs = [...(payload.document_refs || [])];

    if (!openers.length) {
      payload.document_candidates = candidateRows;
      payload.diagnostics.document_candidate_count = 0;
      payload.diagnostics.all_document_capture_attempted = true;
      lastPayload = payload;
      return payload;
    }

    for (let index = 0; index < openers.length; index += 1) {
      const candidate = openers[index];
      onProgress({ index: index + 1, total: openers.length, candidate });
      const result = await openAndCaptureDocumentCandidate(candidate);
      if (result.documents.length) {
        collectedDocuments.push(...result.documents);
        candidateRows[index].captured = true;
      } else {
        candidateRows[index].error = result.error || "sem texto capturado";
      }
      collectedRefs = dedupeDocumentRefs([...collectedRefs, ...result.document_refs]).slice(0, 60);
      await sleep(120);
    }

    const wantedCodes = new Set(candidateRows.map((candidate) => candidate.code).filter(Boolean));
    payload.documents = dedupeDocuments(collectedDocuments).filter((documentRow) => {
      const code = normalizeDocumentCode(documentRow.document_code);
      return code && wantedCodes.has(code);
    });
    payload.document_refs = collectedRefs;
    payload.document_candidates = candidateRows;
    updatePartiesFromDocuments(payload);
    payload.diagnostics.open_document_count = payload.documents.length;
    payload.diagnostics.document_ref_count = payload.document_refs.length;
    payload.diagnostics.document_candidate_count = candidateRows.length;
    payload.diagnostics.document_capture_success_count = candidateRows.filter((candidate) => candidate.captured).length;
    payload.diagnostics.all_document_capture_attempted = true;
    lastPayload = payload;
    return payload;
  }

  function buildPayload() {
    const visibleText = getVisibleText();
    const headerText = cleanPageTextForCaseFields(visibleText);
    const sourceText = [location.href, document.title, visibleText].join("\n");
    const processNumber = extractProcessNumber(sourceText);
    const processDigits = onlyDigits(processNumber);
    const openDocuments = collectOpenDocumentsSync();
    const documentRefs = collectEmbeddedDocumentRefs();
    const fieldText = [
      headerText,
      ...openDocuments.map((documentRow) => String(documentRow.content_text || "").slice(0, 6000))
    ].join("\n");
    const payload = {
      schema_version: "justra.pje.capture.v1",
      source: "pje-trt2-chrome-extension",
      extension_version: "0.4.0",
      captured_at: new Date().toISOString(),
      page: {
        url: location.href,
        host: location.host,
        path: location.pathname,
        title: document.title || "",
        text_length: visibleText.length
      },
      process: {
        number: processNumber,
        number_digits: processDigits.length === 20 ? processDigits : "",
        degree: extractDegreeFromUrl(location.href),
        tribunal: "TRT2",
        class: extractCaseClass(headerText) || firstLabelValue(headerText, ["Classe judicial", "Classe"]),
        court_unit: extractCourtUnit(headerText) || firstLabelValue(headerText, ["Órgão julgador", "Orgao julgador", "Vara", "Unidade judiciária"]),
        filing_date: firstLabelValue(headerText, ["Data de distribuição", "Distribuído em", "Distribuido em", "Autuado em", "Ajuizado em"])
      },
      parties: {
        claimant: firstLabelValue(fieldText, ["Reclamante", "Autor", "Autora", "Exequente", "Agravante", "Polo ativo"]),
        defendant: firstLabelValue(fieldText, ["Reclamado", "Reclamada", "Réu", "Ré", "Executado", "Executada", "Agravado", "Agravada", "Polo passivo"]),
        intimated: firstLabelValue(fieldText, ["Parte intimada", "Destinatário", "Destinatario", "Intimado", "Intimada"])
      },
      movements: collectMovements(visibleText),
      attachments: collectAttachments(),
      documents: openDocuments,
      document_refs: documentRefs,
      raw: {
        visible_text: visibleText.slice(0, MAX_TEXT_CHARS)
      },
      diagnostics: {
        captcha_detected: hasCaptcha(visibleText),
        captured_from_test_url: location.href === TEST_URL,
        open_document_count: openDocuments.length,
        document_ref_count: documentRefs.length
      }
    };
    lastPayload = payload;
    return payload;
  }

  function ensureRoot() {
    if (root) {
      return;
    }
    root = document.createElement("div");
    root.className = "justra-pje-root";

    launcher = document.createElement("button");
    launcher.className = "justra-pje-button";
    launcher.type = "button";
    launcher.textContent = "Justra";
    launcher.title = "Abrir captura da Justra";
    launcher.addEventListener("click", () => openPanel());

    panel = document.createElement("section");
    panel.className = "justra-pje-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Captura Justra PJe");
    panel.innerHTML = `
      <div class="justra-pje-header">
        <div>
          <h2 class="justra-pje-title">Captura PJe</h2>
          <p class="justra-pje-subtitle">Resolva o CAPTCHA no PJe e baixe ou envie os documentos.</p>
        </div>
        <button class="justra-pje-close" type="button" title="Fechar">×</button>
      </div>
      <div class="justra-pje-body">
        <div class="justra-pje-status" data-role="status">Pronto para baixar ou enviar os documentos visíveis.</div>
        <div class="justra-pje-actions">
          <button class="justra-pje-action" data-primary="true" type="button" data-action="downloadAllDocuments">Baixar todos docs</button>
          <button class="justra-pje-action" type="button" data-action="sendAllDocuments">Enviar para Justra</button>
        </div>
        <div class="justra-pje-summary" data-role="summary"></div>
      </div>
    `;

    panel.querySelector(".justra-pje-close").addEventListener("click", () => {
      panel.hidden = true;
      launcher.hidden = false;
    });
    panel.querySelector("[data-action='downloadAllDocuments']").addEventListener("click", () => downloadAllDocumentsJson());
    panel.querySelector("[data-action='sendAllDocuments']").addEventListener("click", () => sendAllDocumentsToJustra());

    root.appendChild(launcher);
    root.appendChild(panel);
    document.documentElement.appendChild(root);
  }

  function openPanel() {
    ensureRoot();
    panel.hidden = false;
    launcher.hidden = true;
    if (!lastPayload) {
      const text = getVisibleText();
      if (hasCaptcha(text)) {
        setStatus("Parece que há um CAPTCHA nesta página. Resolva no PJe antes de baixar ou enviar.", "warning");
      } else {
        setStatus("Pronto para baixar ou enviar os documentos visíveis.", "info");
      }
    }
  }

  function setStatus(message, kind) {
    ensureRoot();
    const status = panel.querySelector("[data-role='status']");
    status.textContent = message;
    status.dataset.kind = kind || "info";
  }

  function renderSummary(payload) {
    ensureRoot();
    const summary = panel.querySelector("[data-role='summary']");
    const processNumber = payload.process.number || "Não identificado";
    const firstMovements = payload.movements.slice(0, 5);
    const documents = payload.documents || [];
    const documentRefs = payload.document_refs || [];
    const documentCandidates = payload.document_candidates || [];
    const firstDocuments = documents.slice(0, 3);
    const capturedCandidates = documentCandidates.filter((candidate) => candidate.captured).length;
    summary.innerHTML = `
      <div class="justra-pje-card">
        <p class="justra-pje-label">Processo</p>
        <p class="justra-pje-value">${escapeHtml(processNumber)}</p>
      </div>
      <div class="justra-pje-card">
        <p class="justra-pje-label">Dados lidos</p>
        <p class="justra-pje-value">${escapeHtml(payload.process.class || "Classe não identificada")}</p>
        <p class="justra-pje-value">${escapeHtml(payload.process.court_unit || "Órgão julgador não identificado")}</p>
      </div>
      <div class="justra-pje-card">
        <p class="justra-pje-label">Partes</p>
        <p class="justra-pje-value">${escapeHtml(payload.parties.claimant || "Polo ativo não identificado")}</p>
        <p class="justra-pje-value">${escapeHtml(payload.parties.defendant || "Polo passivo não identificado")}</p>
      </div>
      <div class="justra-pje-card">
        <p class="justra-pje-label">Movimentos capturados</p>
        <p class="justra-pje-value">${payload.movements.length} itens, ordenados do mais recente para o mais antigo quando há data.</p>
        <ul class="justra-pje-list">
          ${firstMovements.map((movement) => `<li>${escapeHtml(movement.text)}</li>`).join("")}
        </ul>
      </div>
      <div class="justra-pje-card">
        <p class="justra-pje-label">Documentos e links</p>
        <p class="justra-pje-value">${payload.attachments.length} links candidatos e ${documentRefs.length} referência(s) de visualizador.</p>
      </div>
      <div class="justra-pje-card">
        <p class="justra-pje-label">Inteiro teor capturado</p>
        <p class="justra-pje-value">${documents.length ? `${documents.length} documento(s) com texto.` : "Nenhum texto de documento aberto capturado ainda."}</p>
        ${documentCandidates.length ? `<p class="justra-pje-value">${capturedCandidates}/${documentCandidates.length} documento(s) da lista visível capturado(s).</p>` : ""}
        <ul class="justra-pje-list">
          ${firstDocuments.map((documentRow) => `<li>${escapeHtml(documentRow.title)} · ${documentRow.text_length || 0} caracteres</li>`).join("")}
        </ul>
      </div>
    `;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function filenameForPayload(payload) {
    const number = payload.process.number_digits || onlyDigits(payload.process.number) || "processo";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `justra-pje-${number}-${stamp}.json`;
  }

  function downloadPayload(payload) {
    renderSummary(payload);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filenameForPayload(payload);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function payloadStats(payload) {
    return {
      process_number: payload.process.number,
      movements: payload.movements.length,
      documents: payload.documents.length,
      document_candidates: (payload.document_candidates || []).length,
      captured_candidates: (payload.document_candidates || []).filter((candidate) => candidate.captured).length,
      document_refs: payload.document_refs.length,
      captcha_detected: payload.diagnostics.captcha_detected
    };
  }

  async function downloadAllDocumentsJson() {
    setStatus("Capturando todos os documentos antes de baixar...", "info");
    const payload = await buildPayloadWithAllVisibleDocuments((progress) => {
      setStatus(`Abrindo documento ${progress.index}/${progress.total}: ${progress.candidate.title || progress.candidate.code}`, "info");
    });
    downloadPayload(payload);
    const total = payload.diagnostics.document_candidate_count || 0;
    const captured = payload.diagnostics.document_capture_success_count || 0;
    setStatus(`JSON baixado com ${captured}/${total} documento(s) capturado(s).`, captured === total ? "success" : "warning");
    return payload;
  }

  function importPayloadIntoJustra(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "JUSTRA_IMPORT_PJE", payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || "erro desconhecido"));
          return;
        }
        resolve(response.data || {});
      });
    });
  }

  async function sendPayloadToJustra(payload) {
    renderSummary(payload);
    setStatus("Enviando para a Justra local em 127.0.0.1:8787...", "info");
    try {
      const data = await importPayloadIntoJustra(payload);
      setStatus(`Enviado para a Justra. Import ID: ${data.import_id || "registrado"}.`, "success");
      return data;
    } catch (error) {
      setStatus(`Não consegui enviar: ${error.message}`, "error");
      throw error;
    }
  }

  async function sendAllDocumentsToJustra() {
    setStatus("Capturando todos os documentos antes de enviar...", "info");
    const payload = await buildPayloadWithAllVisibleDocuments((progress) => {
      setStatus(`Abrindo documento ${progress.index}/${progress.total}: ${progress.candidate.title || progress.candidate.code}`, "info");
    });
    const importResult = await sendPayloadToJustra(payload);
    return { payload, importResult };
  }

  if (window.top !== window) {
    installFrameCaptureBridge();
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }
    if (message.type === "JUSTRA_PJE_PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "JUSTRA_OPEN_PANEL") {
      openPanel();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "JUSTRA_DOWNLOAD_ALL_DOCUMENTS_NOW") {
      openPanel();
      downloadAllDocumentsJson()
        .then((payload) => sendResponse({ ok: true, ...payloadStats(payload) }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "JUSTRA_SEND_ALL_DOCUMENTS_NOW") {
      openPanel();
      sendAllDocumentsToJustra()
        .then(({ payload, importResult }) => sendResponse({ ok: true, ...payloadStats(payload), import_id: importResult.import_id || "" }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  window.addEventListener("justra:pje:open", openPanel);
  ensureRoot();
})();

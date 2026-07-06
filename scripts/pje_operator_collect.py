#!/usr/bin/env python3
"""Coleta assistida do PJe para operador humano.

O script abre um navegador visível, espera o operador resolver o CAPTCHA/login
manualmente e só então captura a página do processo já liberada. Ele não tenta
resolver, automatizar ou contornar CAPTCHA.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.getenv("JUSTRA_DATA_DIR", ROOT / "data"))
DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEFAULT_ORIGIN = "chrome-extension://justra-pje-operator-python"

PROCESS_FORMATTED_RE = re.compile(r"\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b")
PROCESS_COMPACT_RE = re.compile(r"(?<!\d)(\d{20})(?!\d)")


COLLECTOR_JS = r"""
async ({ expectedCnj, maxDocuments }) => {
  const PROCESS_FORMATTED_RE = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
  const PROCESS_COMPACT_RE = /(?<!\d)(\d{20})(?!\d)/;
  const BR_DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?\b/;
  const DOCUMENT_ITEM_RE = /\b(Senten[çc]a|Decis[ãa]o|Despacho|Ac[óo]rd[ãa]o|Ata(?:\s+d[ae]\s+audi[êe]ncia)?|Peti[çc][ãa]o|Certid[ãa]o|Intima[çc][ãa]o|Notifica[çc][ãa]o|Alvar[áa]|Mandado|Of[íi]cio|Termo|C[áa]lculo|Laudo|Manifesta[çc][ãa]o|Recurso|Contrarraz[õo]es|Embargos|Contesta[çc][ãa]o|Inicial)\s*(?:\([^)]{1,100}\))?\s*[-–—]\s*([a-f0-9]{6,40})\b/gi;
  const MAX_TEXT_CHARS = 90000;
  const MAX_DOCUMENT_TEXT_CHARS = 180000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeText = (value) => String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  const compactSpaces = (value) => normalizeText(value).replace(/\s+/g, " ").trim();
  const onlyDigits = (value) => String(value || "").replace(/\D/g, "");
  const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const formatCnj = (digits) => /^\d{20}$/.test(digits)
    ? `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16, 20)}`
    : "";
  const getVisibleText = () => normalizeText(document.body ? document.body.innerText : "");
  const isVisibleElement = (element) => {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20;
  };
  const cleanFieldValue = (value) => compactSpaces(value).replace(/^[-:;]+/, "").replace(/[-:;]+$/, "").slice(0, 240);
  const extractProcessNumber = (text) => {
    const source = String(text || "");
    const formatted = source.match(PROCESS_FORMATTED_RE);
    if (formatted) return formatted[0];
    const compact = source.match(PROCESS_COMPACT_RE);
    return compact ? formatCnj(compact[1]) : "";
  };
  const hasCaptcha = (text) => {
    const value = String(text || "");
    if (/captcha|recaptcha|hcaptcha|n[aã]o sou um rob[oô]/i.test(value)) return true;
    return Boolean(document.querySelector("iframe[src*='captcha'], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, [data-sitekey]"));
  };
  const cleanPageTextForCaseFields = (text) => {
    const lines = String(text || "").split(/\n+/).map((line) => compactSpaces(line)).filter(Boolean);
    const stopIndex = lines.findIndex((line) => /^Documentos do processo$/i.test(line));
    return (stopIndex >= 0 ? lines.slice(0, stopIndex) : lines.slice(0, 60)).join("\n");
  };
  const firstLabelValue = (text, labels) => {
    const lines = String(text || "").split(/\n+/).map((line) => compactSpaces(line)).filter(Boolean);
    for (const label of labels) {
      const sameLine = new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "i");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const sameLineMatch = line.match(sameLine);
        if (sameLineMatch && sameLineMatch[1]) return cleanFieldValue(sameLineMatch[1]);
        if (line.toLowerCase() === label.toLowerCase() && lines[index + 1]) return cleanFieldValue(lines[index + 1]);
      }
    }
    const compact = compactSpaces(text);
    for (const label of labels) {
      const inline = new RegExp(`${escapeRegExp(label)}\\s*:?\\s*([^\\n\\r]{2,240})`, "i");
      const match = compact.match(inline);
      if (match && match[1]) return cleanFieldValue(match[1]);
    }
    return "";
  };
  const extractCourtUnit = (text) => {
    const head = cleanPageTextForCaseFields(text);
    const withProcessHeader = head.match(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\s*\(([^)]+)\)/);
    if (withProcessHeader && withProcessHeader[1]) return cleanFieldValue(withProcessHeader[1]);
    const firstVara = head.match(/\b(\d+[ªa]?\s+Vara do Trabalho de [^\n()]{2,120})/i);
    return firstVara && firstVara[1] ? cleanFieldValue(firstVara[1]) : "";
  };
  const extractCaseClass = (text) => {
    const head = cleanPageTextForCaseFields(text);
    const match = head.match(/\b([A-Z][A-Za-z]{2,10})\s+\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/);
    return match ? match[1] : "";
  };
  const extractDegreeFromUrl = (url) => {
    const match = String(url || "").match(/\/detalhe-processo\/[^/]+\/(\d+)/);
    return match ? match[1] : "";
  };
  const parseBrDateMillis = (value) => {
    const match = String(value || "").match(BR_DATE_RE);
    if (!match) return 0;
    return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || "0"), Number(match[5] || "0"));
  };
  const looksLikeMovement = (text) => {
    const value = compactSpaces(text);
    if (value.length < 12 || value.length > 900) return false;
    if (BR_DATE_RE.test(value)) return true;
    return /\b(movimenta[cç][aã]o|juntada|remessa|conclusos|distribui[cç][aã]o|intima[cç][aã]o|pauta|audi[eê]ncia|senten[cç]a|ac[oó]rd[aã]o|despacho|decis[aã]o)\b/i.test(value);
  };
  const collectMovements = (text) => {
    const rows = [];
    document.querySelectorAll("tr").forEach((row) => {
      const cells = Array.from(row.cells || []).map((cell) => compactSpaces(cell.innerText)).filter(Boolean);
      const value = cells.join(" · ");
      if (looksLikeMovement(value)) rows.push({ text: value, source: "table" });
    });
    ["li", "article", "[role='row']", "[class*='timeline']", "[class*='moviment']", "[class*='andament']", "[class*='evento']"].forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        const value = compactSpaces(element.innerText || element.textContent || "");
        if (looksLikeMovement(value)) rows.push({ text: value, source: "element" });
      });
    });
    const lines = String(text || "").split(/\n+/).map((line) => compactSpaces(line)).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      if (!BR_DATE_RE.test(lines[index])) continue;
      const block = compactSpaces([lines[index], lines[index + 1] || "", lines[index + 2] || ""].filter(Boolean).join(" · "));
      if (looksLikeMovement(block)) rows.push({ text: block, source: "text" });
    }
    const seen = new Set();
    const deduped = [];
    rows.forEach((row) => {
      const value = compactSpaces(row.text);
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push({
        id: `pje-movement-${deduped.length + 1}`,
        text: value,
        date_text: (value.match(BR_DATE_RE) || [""])[0],
        sort_time: parseBrDateMillis(value),
        source: row.source
      });
    });
    return deduped.sort((left, right) => right.sort_time - left.sort_time).slice(0, 80).map(({ sort_time, ...row }) => row);
  };
  const collectAttachments = () => {
    const seen = new Set();
    const rows = [];
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.href || "";
      const label = compactSpaces(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "");
      if (!href || seen.has(href) || !/documento|download|autos|integra|pdf|arquivo|anexo|expediente/i.test(`${href} ${label}`)) return;
      seen.add(href);
      rows.push({ label: label.slice(0, 180) || "Documento do PJe", href, kind: /\.pdf(?:$|[?#])/i.test(href) || /pdf/i.test(label) ? "pdf_or_document" : "link" });
    });
    return rows.slice(0, 50);
  };
  const stripCaptureUiText = (text) => normalizeText(String(text || "").split(/\n+/).filter((line) => !/^Justra|^Operador PJe|^Captura PJe|^Baixar todos docs|^Enviar agora$/i.test(compactSpaces(line))).join("\n"));
  const documentScore = (text) => {
    const value = compactSpaces(text);
    if (value.length < 240) return 0;
    let score = 0;
    if (value.length > 800) score += 1;
    if (value.length > 2000) score += 1;
    if (/\b(PODER JUDICI[ÁA]RIO|JUSTI[ÇC]A DO TRABALHO|TRIBUNAL REGIONAL DO TRABALHO|VARA DO TRABALHO)\b/i.test(value)) score += 3;
    if (/\b(SENTEN[ÇC]A|DECIS[ÃA]O|DESPACHO|AC[ÓO]RD[ÃA]O|ATA DE AUDI[ÊE]NCIA)\b/i.test(value)) score += 2;
    if (/\b(RELAT[ÓO]RIO|FUNDAMENTA[ÇC][ÃA]O|DISPOSITIVO|DECIDO|JULGO|VISTOS|CONCLUS[ÃA]O)\b/i.test(value)) score += 2;
    if (/Assinado eletronicamente|Documento assinado|Certid[aã]o de publica[cç][aã]o/i.test(value)) score += 2;
    return score;
  };
  const detectDocumentType = (text, title) => {
    const value = `${title || ""}\n${text || ""}`;
    const options = [["sentenca", /\bSenten[çc]a\b/i], ["decisao", /\bDecis[ãa]o\b/i], ["despacho", /\bDespacho\b/i], ["acordao", /\bAc[óo]rd[ãa]o\b/i], ["ata", /\bAta d[ae] audi[êe]ncia\b/i], ["peticao", /\bPeti[çc][ãa]o\b/i], ["certidao", /\bCertid[ãa]o\b/i], ["intimacao", /\bIntima[çc][ãa]o\b/i]];
    const match = options.find(([, pattern]) => pattern.test(value));
    return match ? match[0] : "documento";
  };
  const normalizeDocumentCode = (value) => {
    const match = String(value || "").match(/[a-f0-9]{6,40}/i);
    return match ? match[0].toLowerCase() : "";
  };
  const extractDocumentCode = (text, url) => {
    const explicitId = String(text || "").match(/\bId\s+([a-f0-9]{6,40})\b/i);
    if (explicitId) return normalizeDocumentCode(explicitId[1]);
    const hash = String(url || "").match(/#([a-f0-9]{6,40})\b/i);
    return hash ? normalizeDocumentCode(hash[1]) : "";
  };
  const titleFromDocumentText = (text, fallback = "") => {
    const lines = String(text || "").split(/\n+/).map((line) => compactSpaces(line)).filter(Boolean);
    const explicit = lines.find((line) => /\b(Senten[çc]a|Decis[ãa]o|Despacho|Ac[óo]rd[ãa]o|Ata|Certid[ãa]o|Intima[çc][ãa]o|Peti[çc][ãa]o)\b/i.test(line) && line.length <= 180);
    return explicit || lines.find((line) => line.length >= 6 && line.length <= 160 && !BR_DATE_RE.test(line)) || fallback || document.title || "Documento PJe";
  };
  const documentFromText = (text, source) => {
    const contentText = stripCaptureUiText(text).slice(0, MAX_DOCUMENT_TEXT_CHARS);
    const score = documentScore(contentText);
    if (score < 4) return null;
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
  };
  const collectOpenDocumentsSync = () => {
    const selectors = ["[role='dialog']", ".modal", ".modal-content", ".cdk-overlay-pane", ".mat-dialog-container", ".p-dialog", ".ui-dialog", "article", "main", "[class*='documento']", "[id*='documento']", "[class*='inteiro']", "[id*='inteiro']", "[class*='visualizador']", "[id*='visualizador']"];
    const elements = new Set();
    selectors.forEach((selector) => document.querySelectorAll(selector).forEach((element) => {
      if (isVisibleElement(element)) elements.add(element);
    }));
    const docs = [];
    elements.forEach((element) => {
      const doc = documentFromText(element.innerText || element.textContent || "", { title: element.getAttribute("aria-label") || "", url: location.href, source: "top", method: "element-visible-text", index: docs.length + 1 });
      if (doc) docs.push(doc);
    });
    const bodyText = stripCaptureUiText(getVisibleText());
    if (!docs.length && documentScore(bodyText) >= 4) {
      const doc = documentFromText(bodyText, { title: document.title || "", url: location.href, source: "top", method: "body-visible-text", index: 1 });
      if (doc) docs.push(doc);
    }
    return docs;
  };
  const documentItemMatches = (text) => {
    const matches = [];
    DOCUMENT_ITEM_RE.lastIndex = 0;
    for (const match of compactSpaces(text).matchAll(DOCUMENT_ITEM_RE)) {
      matches.push({ type_label: cleanFieldValue(match[1] || "Documento"), code: normalizeDocumentCode(match[2] || ""), title: cleanFieldValue(match[0] || "") });
    }
    return matches;
  };
  const findDocumentOpeners = () => {
    const selector = ["a", "button", "[role='button']", "[onclick]", "[tabindex]", "li", "tr", "[class*='timeline']", "[class*='moviment']", "[class*='andament']", "[class*='evento']", "[class*='documento']", "[id*='documento']"].join(",");
    const rows = [];
    const seen = new Set();
    Array.from(document.querySelectorAll(selector)).forEach((element) => {
      if (!isVisibleElement(element)) return;
      const text = compactSpaces(element.innerText || element.textContent || "");
      if (!text || text.length > 900 || /baixar\s+certid[aã]o|certid[aã]o\s+de\s+juntada|baixar\s+arquivo|download/i.test(text)) return;
      documentItemMatches(text).forEach((match) => {
        if (!match.code || seen.has(match.code)) return;
        seen.add(match.code);
        rows.push({ ...match, text, target: element });
      });
    });
    return rows.slice(0, maxDocuments || 80);
  };
  const clickElement = (element) => {
    try {
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const eventOptions = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + Math.min(rect.height / 2, 24) };
      ["pointerdown", "mousedown", "mouseup", "click"].forEach((eventName) => {
        const EventClass = eventName.startsWith("pointer") && "PointerEvent" in window ? PointerEvent : MouseEvent;
        element.dispatchEvent(new EventClass(eventName, eventOptions));
      });
      if (typeof element.click === "function") element.click();
      return true;
    } catch (_error) {
      return false;
    }
  };
  const dedupeDocuments = (documents) => {
    const deduped = [];
    documents.filter(Boolean).sort((left, right) => (right.confidence_score || 0) - (left.confidence_score || 0) || (right.text_length || 0) - (left.text_length || 0)).forEach((doc) => {
      const code = normalizeDocumentCode(doc.document_code);
      const text = compactSpaces(doc.content_text || "");
      const exists = deduped.some((existing) => {
        const existingCode = normalizeDocumentCode(existing.document_code);
        const existingText = compactSpaces(existing.content_text || "");
        return (code && existingCode && code === existingCode) || (text.length > 280 && existingText.includes(text.slice(0, 800)));
      });
      if (!exists) deduped.push({ ...doc, id: `pje-document-${deduped.length + 1}` });
    });
    return deduped;
  };
  const captureCandidateDocument = async (candidate) => {
    if (candidate.code) location.hash = candidate.code;
    await sleep(500);
    clickElement(candidate.target);
    await sleep(1200);
    return collectOpenDocumentsSync().filter((doc) => {
      const code = normalizeDocumentCode(doc.document_code);
      return !candidate.code || code === candidate.code || new RegExp(`\\b${escapeRegExp(candidate.code)}\\b`, "i").test(`${doc.title}\n${doc.content_text}`);
    }).map((doc) => ({ ...doc, document_code: normalizeDocumentCode(doc.document_code || candidate.code), opener_title: candidate.title, opener_type_label: candidate.type_label, opened_from_timeline: true }));
  };

  const visibleText = getVisibleText();
  const headerText = cleanPageTextForCaseFields(visibleText);
  const sourceText = [location.href, document.title, visibleText].join("\n");
  const processNumber = extractProcessNumber(sourceText);
  const processDigits = onlyDigits(processNumber);
  if (expectedCnj && onlyDigits(expectedCnj) !== processDigits) {
    throw new Error(`CNJ aberto (${processNumber || "não identificado"}) não confere com ${expectedCnj}`);
  }
  if (hasCaptcha(visibleText)) {
    throw new Error("CAPTCHA/login ainda aparece na página; resolva manualmente antes da coleta");
  }

  const documents = [...collectOpenDocumentsSync()];
  const documentCandidates = findDocumentOpeners().map((candidate) => ({ code: candidate.code, title: candidate.title, type_label: candidate.type_label, captured: false, error: "" }));
  const openers = findDocumentOpeners();
  for (let index = 0; index < openers.length; index += 1) {
    try {
      const captured = await captureCandidateDocument(openers[index]);
      if (captured.length) {
        documents.push(...captured);
        documentCandidates[index].captured = true;
      } else {
        documentCandidates[index].error = "sem texto capturado";
      }
    } catch (error) {
      documentCandidates[index].error = error.message || "erro ao abrir documento";
    }
    await sleep(120);
  }
  const dedupedDocuments = dedupeDocuments(documents).slice(0, maxDocuments || 80);
  const fieldText = [headerText, ...dedupedDocuments.map((doc) => String(doc.content_text || "").slice(0, 6000))].join("\n");
  const payload = {
    schema_version: "justra.pje.capture.v1",
    source: "pje-trt2-python-operator",
    extension_version: "python-operator",
    captured_at: new Date().toISOString(),
    capture_mode: "operator_python",
    page: {
      url: location.href,
      referrer: document.referrer || "",
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
    documents: dedupedDocuments,
    document_refs: [],
    document_candidates: documentCandidates,
    raw: {
      visible_text: visibleText.slice(0, MAX_TEXT_CHARS)
    },
    diagnostics: {
      captcha_detected: hasCaptcha(visibleText),
      open_document_count: dedupedDocuments.length,
      document_ref_count: 0,
      document_candidate_count: documentCandidates.length,
      document_capture_success_count: documentCandidates.filter((candidate) => candidate.captured).length,
      all_document_capture_attempted: true
    }
  };
  return payload;
}
"""


READY_CHECK_JS = r"""
({ expectedCnj, minTextLength, minMovements }) => {
  const PROCESS_FORMATTED_RE = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
  const PROCESS_COMPACT_RE = /(?<!\d)(\d{20})(?!\d)/;
  const BR_DATE_RE = /\b\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?\b/;
  const normalizeText = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  const onlyDigits = (value) => String(value || "").replace(/\D/g, "");
  const formatCnj = (digits) => /^\d{20}$/.test(digits)
    ? `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16, 20)}`
    : "";
  const text = normalizeText(document.body ? document.body.innerText : "");
  const hasCaptcha = /captcha|recaptcha|hcaptcha|n[aã]o sou um rob[oô]/i.test(text) || Boolean(document.querySelector("iframe[src*='captcha'], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, [data-sitekey]"));
  const source = [location.href, document.title, text].join("\n");
  const formatted = source.match(PROCESS_FORMATTED_RE);
  const compact = source.match(PROCESS_COMPACT_RE);
  const processNumber = formatted ? formatted[0] : compact ? formatCnj(compact[1]) : "";
  const processDigits = onlyDigits(processNumber);
  const expectedDigits = onlyDigits(expectedCnj || "");
  const movementMatches = text.match(BR_DATE_RE) || [];
  if (hasCaptcha) return { ok: false, reason: "Aguardando você resolver o CAPTCHA/login manualmente.", processNumber, textLength: text.length, movementCount: movementMatches.length };
  if (!processDigits) return { ok: false, reason: "Aguardando CNJ visível na página.", processNumber, textLength: text.length, movementCount: movementMatches.length };
  if (expectedDigits && expectedDigits !== processDigits) return { ok: false, reason: `CNJ aberto (${processNumber}) não confere com ${expectedCnj}.`, processNumber, textLength: text.length, movementCount: movementMatches.length };
  if (text.length < minTextLength) return { ok: false, reason: "Aguardando conteúdo do processo carregar.", processNumber, textLength: text.length, movementCount: movementMatches.length };
  if (movementMatches.length < minMovements) return { ok: false, reason: "Aguardando movimentações do processo.", processNumber, textLength: text.length, movementCount: movementMatches.length };
  return { ok: true, reason: "Página liberada.", processNumber, textLength: text.length, movementCount: movementMatches.length };
}
"""


def compact_process_number(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def format_process_number(value: str) -> str:
    digits = compact_process_number(value)
    if len(digits) != 20:
        return value
    return f"{digits[:7]}-{digits[7:9]}.{digits[9:13]}.{digits[13:14]}.{digits[14:16]}.{digits[16:20]}"


def extract_process_number(value: str) -> str:
    formatted = PROCESS_FORMATTED_RE.search(value or "")
    if formatted:
        return formatted.group(0)
    compact = PROCESS_COMPACT_RE.search(value or "")
    if compact:
        return format_process_number(compact.group(1))
    return ""


def pje_url_for_process(cnj: str, degree: str = "1") -> str:
    return f"https://pje.trt2.jus.br/consultaprocessual/captcha/detalhe-processo/{format_process_number(cnj)}/{degree}"


def slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value or "").strip("_") or "processo"


def default_output_path(cnj: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return DATA_ROOT / "operator_pje_captures" / f"pje-{slug(compact_process_number(cnj))}-{stamp}.json"


def load_playwright():
    try:
        from playwright.sync_api import sync_playwright  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "Playwright Python não está instalado neste venv.\n"
            "Instale para testar:\n\n"
            "  .venv/bin/python -m pip install playwright\n"
            "  .venv/bin/python -m playwright install chromium\n\n"
            "Depois rode novamente o comando de coleta.\n"
        ) from exc
    return sync_playwright


def wait_for_process_page(page: Any, cnj: str, timeout_seconds: int, min_text_length: int, min_movements: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_reason = ""
    while time.monotonic() < deadline:
        state = page.evaluate(
            READY_CHECK_JS,
            {
                "expectedCnj": cnj,
                "minTextLength": min_text_length,
                "minMovements": min_movements,
            },
        )
        reason = str(state.get("reason") or "")
        if reason != last_reason:
            print(f"[pje] {reason} texto={state.get('textLength')} movimentos={state.get('movementCount')}")
            last_reason = reason
        if state.get("ok"):
            return state
        time.sleep(1.5)
    raise TimeoutError(f"página PJe não ficou pronta em {timeout_seconds}s: {last_reason}")


def write_payload(payload: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def send_to_justra(payload: dict[str, Any], justra_url: str, origin: str, timeout: int = 120) -> dict[str, Any]:
    endpoint = justra_url.rstrip("/") + "/api/pje-extension/import"
    response = requests.post(
        endpoint,
        json=payload,
        headers={
            "Content-Type": "application/json",
            "Origin": origin,
            "User-Agent": "Justra PJe Python Operator/0.1",
        },
        timeout=timeout,
    )
    text = response.text
    try:
        data = response.json() if text else {}
    except ValueError:
        data = {"raw": text}
    if not response.ok:
        raise RuntimeError(f"Justra respondeu HTTP {response.status_code}: {data}")
    return data


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Coleta PJe assistida por operador humano.")
    parser.add_argument("--cnj", required=True, help="Número CNJ do processo.")
    parser.add_argument("--justra-url", default="https://staging.justra.com.br", help="Base URL da Justra.")
    parser.add_argument("--job-id", default="", help="ID do job PJe na fila da Justra.")
    parser.add_argument("--pje-url", default="", help="URL PJe já parametrizada. Se omitida, usa TRT2 consulta processual.")
    parser.add_argument("--degree", default="1", help="Grau do processo no PJe. Padrão: 1.")
    parser.add_argument("--timeout", type=int, default=300, help="Tempo máximo aguardando você resolver CAPTCHA/login.")
    parser.add_argument("--settle-seconds", type=float, default=2.5, help="Espera extra após a página ficar pronta.")
    parser.add_argument("--min-text-length", type=int, default=700, help="Texto mínimo para considerar a página carregada.")
    parser.add_argument("--min-movements", type=int, default=1, help="Quantidade mínima de datas/movimentos para considerar pronto.")
    parser.add_argument("--max-documents", type=int, default=80, help="Máximo de documentos/tentativas de documentos.")
    parser.add_argument("--output", default="", help="Caminho para salvar o JSON capturado.")
    parser.add_argument("--dry-run", action="store_true", help="Captura e salva JSON, mas não envia para a Justra.")
    parser.add_argument("--origin", default=DEFAULT_ORIGIN, help="Origin enviado para o endpoint atual de importação.")
    parser.add_argument("--headless", action="store_true", help="Executar sem janela. Não use se precisar resolver CAPTCHA.")
    parser.add_argument("--chrome-path", default=os.getenv("JUSTRA_CHROME_PATH", DEFAULT_CHROME_PATH), help="Caminho do Google Chrome.")
    parser.add_argument("--keep-open", action="store_true", help="Manter o navegador aberto após captura.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cnj = format_process_number(args.cnj)
    page_url = args.pje_url or pje_url_for_process(cnj, args.degree)
    output_path = Path(args.output) if args.output else default_output_path(cnj)

    sync_playwright = load_playwright()
    with sync_playwright() as playwright:
        launch_options: dict[str, Any] = {
            "headless": bool(args.headless),
        }
        if args.chrome_path and Path(args.chrome_path).exists():
            launch_options["executable_path"] = args.chrome_path
        browser = playwright.chromium.launch(**launch_options)
        context = browser.new_context(locale="pt-BR", viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        print(f"[pje] Abrindo {page_url}")
        page.goto(page_url, wait_until="domcontentloaded", timeout=60_000)
        print("[pje] Resolva o CAPTCHA/login manualmente na janela aberta. O script vai aguardar a página do processo.")
        state = wait_for_process_page(
            page,
            cnj=cnj,
            timeout_seconds=args.timeout,
            min_text_length=args.min_text_length,
            min_movements=args.min_movements,
        )
        print(f"[pje] Página pronta: {state.get('processNumber')} ({state.get('textLength')} caracteres)")
        if args.settle_seconds > 0:
            time.sleep(args.settle_seconds)
        payload = page.evaluate(
            COLLECTOR_JS,
            {
                "expectedCnj": cnj,
                "maxDocuments": max(0, int(args.max_documents)),
            },
        )
        payload["operator_capture"] = {
            "script": "scripts/pje_operator_collect.py",
            "captured_at": datetime.now().isoformat(timespec="seconds"),
            "requested_cnj": cnj,
            "requested_url": page_url,
            "justra_url": args.justra_url,
            "job_id": args.job_id,
        }
        if args.job_id:
            payload["job_id"] = args.job_id
        write_payload(payload, output_path)
        print(
            "[pje] JSON salvo em "
            f"{output_path} | movimentos={len(payload.get('movements') or [])} "
            f"docs={len(payload.get('documents') or [])}"
        )
        if not args.dry_run:
            result = send_to_justra(payload, args.justra_url, args.origin)
            print(f"[pje] Enviado para Justra. Import ID: {result.get('import_id') or 'registrado'}")
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print("[pje] Dry-run ativo: não enviei para a Justra.")
        if args.keep_open:
            input("[pje] Pressione Enter para fechar o navegador...")
        context.close()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

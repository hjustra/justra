import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DATA_ROOT = path.resolve(process.env.JUSTRA_DATA_DIR || path.join(ROOT, "data"));
const filePath = path.resolve(
  process.argv[2] ? ROOT : DATA_ROOT,
  process.argv[2] ||
    "samples/falcao/sample_1000_documents.jsonl",
);
const citationBase =
  "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/citacao";
const idFields = {
  acordaos: "idDocumentoAcordao",
  decisoesmonocraticas: "idDocumento",
  sentencas: "idSentenca",
  recursorevista: "idRecursoRevista",
  precedentes: "id",
};

const documents = fs
  .readFileSync(filePath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

for (const document of documents) {
  const collection = document._justra?.collection || "";
  const id =
    document[idFields[collection]] || document.id || document.idTema || "";
  const tribunal = document.tribunal || "sem-tribunal";
  if (!id || !collection) continue;
  document._justra.document_key = `${collection}:${tribunal}:${id}`;
  document._justra.citation_url = `${citationBase}/${encodeURIComponent(
    collection,
  )}/${encodeURIComponent(tribunal)}/${encodeURIComponent(id)}`;
}

const output = `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`;
const temporaryPath = `${filePath}.tmp`;
fs.writeFileSync(temporaryPath, output);
fs.renameSync(temporaryPath, filePath);

const keys = documents.map((document) => document._justra.document_key);
console.log(
  JSON.stringify({
    file: filePath,
    documents: documents.length,
    unique_keys: new Set(keys).size,
    citation_links: documents.filter(
      (document) => document._justra.citation_url,
    ).length,
    bytes: Buffer.byteLength(output),
  }),
);

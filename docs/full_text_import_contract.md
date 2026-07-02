# Full Text Import Contract

This is the open slot for the future full-text source.

Codex will not implement captcha bypass. If you later obtain full text from an
authorized source, provider, manual export, or your own ingestion layer, place
files in:

```text
data/mvp/trt2/full_text_inbox/
```

Accepted formats:

```text
.json
.jsonl
.csv
.txt
```

Preferred fields:

```text
process_number
document_id
document_type
degree
court_unit
judge_name
reporting_judge
decision_date
decision_text
source_url
source_provider
raw_path
```

Then run:

```bash
python scripts/import_full_text_documents.py
```

The importer writes into the DuckDB table:

```text
full_text_documents
```

Once this table has enough rows, the product can add the strong claims:

```text
fundamentos vencedores
teses rejeitadas
precedentes citados
tipo de prova valorizada
linha argumentativa por juiz/vara
```

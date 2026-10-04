# Licensed CPT reference data

Place an authorized CPT reference CSV here as `cpt_reference.csv`. It must include `code` and `description` columns. Configure its release with `CPT_REFERENCE_VERSION`.

Do not commit or distribute licensed CPT data unless your license permits it. When no file is supplied, CPT values are explicitly left unverified and excluded from verified results; ICD-10-CM reference verification continues normally.

## Optional CPT pricing ranges

Price-to-range checks require a separate authorized pricing CSV; code membership alone is not a pricing reference. The file must contain `code`, `reference_min`, `reference_max`, and `currency` columns, with one row per CPT code. An optional `source_note` column can record setting or locality details. Configure `CPT_PRICING_REFERENCE_CSV`, `CPT_PRICING_REFERENCE_SOURCE`, and `CPT_PRICING_REFERENCE_VERSION`, and set `CPT_PRICING_REFERENCE_AUTHORIZED=true` only after confirming the source is authorized and appropriate for the claims being reviewed. The currency must be an ISO 4217 three-letter code and each range must be finite, non-negative, and ordered.

The bundled `medical_codes.xlsx` ranges are historical receipt examples. They are shown as example-only comparisons, never as authoritative prices or a basis for automatic claim approval. Do not commit or distribute pricing data unless its license permits it.

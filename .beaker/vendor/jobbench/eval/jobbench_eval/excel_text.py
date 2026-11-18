"""Complete spreadsheet text with compact, exact formula families."""

from __future__ import annotations

import csv
import io
import json

from openpyxl.formula.translate import Translator
from openpyxl.utils.cell import coordinate_from_string, column_index_from_string, get_column_letter


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _position(record):
    column, row = coordinate_from_string(record["cell"])
    return column_index_from_string(column), row


def _visible_value(record, calculated):
    computed = calculated.get(record["cell"]) if "formula" in record else None
    if computed is None:
        return record["value"]
    if computed["error_code"]:
        return f"{computed['display']} [Calc error {computed['error_code']}]"
    if record.get("date_format"):
        return computed["display"]
    return computed["value"]


def _formula_detail(record, calculated):
    line = f"{record['cell']}: formula={_json(record['formula'])}; cached={_json(record['value'])}"
    if record.get("range"):
        line += f"; array_range={record['range']}"
    computed = calculated.get(record["cell"])
    if computed is not None:
        line += f"; recalculated={_json(_visible_value(record, calculated))}; display={_json(computed['display'])}"
    return line


def _formula_groups(records):
    """Group only adjacent same-column cells proven to be exact fill-down copies."""
    group = []
    translator = None
    previous = None
    for record in sorted(records, key=_position):
        position = _position(record)
        matches = False
        if (translator is not None and not record.get("range") and previous is not None
                and position == (previous[0], previous[1] + 1)):
            try:
                matches = translator.translate_formula(record["cell"]) == record["formula"]
            except Exception:
                # Unsupported formulas remain individual evidence, not omitted.
                pass
        if not matches:
            if group:
                yield group
            group = []
            translator = None
            if not record.get("range") and record["formula"].startswith("="):
                try:
                    translator = Translator(record["formula"], origin=record["cell"])
                except Exception:
                    pass
        group.append(record)
        previous = position
    if group:
        yield group


def _formula_lines(records, calculated):
    formulas = [record for record in records if "formula" in record]
    lines = []
    for group in _formula_groups(formulas):
        if len(group) == 1:
            lines.append(_formula_detail(group[0], calculated))
            continue
        anchor = group[0]
        blank_caches = sum(record["value"] is None for record in group)
        zero_caches = sum(not isinstance(record["value"], bool) and record["value"] == 0 for record in group)
        line = (f"{anchor['cell']}:{group[-1]['cell']}: {len(group)} formulas; "
                f"fill down from {anchor['cell']} formula={_json(anchor['formula'])}; "
                f"cached null={blank_caches}, zero={zero_caches}")
        computed = [calculated[record["cell"]] for record in group if record["cell"] in calculated]
        if computed:
            blanks = sum(item["value"] in (None, "") and not item["error_code"] for item in computed)
            errors = sum(bool(item["error_code"]) for item in computed)
            line += f"; recalculated cells={len(computed)}, blank={blanks}, errors={errors}"
        lines.append(line)
        # Small formula sets retain all cache comparisons. In large families,
        # retain explicit error locations in addition to the compact range.
        for record in group:
            if len(formulas) <= 32 or calculated.get(record["cell"], {}).get("error_code"):
                lines.append(_formula_detail(record, calculated))
    return lines


def _csv_row(values):
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerow(values)
    return buffer.getvalue().removesuffix("\n")


def _sheet_sections(name, records, calculated):
    rows = {}
    all_rows = set()
    columns = set()
    for record in records:
        column, row = _position(record)
        all_rows.add(row)
        value = _visible_value(record, calculated)
        if value is None or value == "":
            continue
        rows.setdefault(row, {})[column] = value
        columns.add(column)
    columns = sorted(columns)
    grid_header = _csv_row(["row", *(get_column_letter(column) for column in columns)])
    grid_rows = [_csv_row([row, *(values.get(column, "") for column in columns)])
                 for row, values in sorted(rows.items())]
    if not grid_rows:
        grid_rows = ["[No nonempty value rows; formula cells are listed above.]"]
    count = sum("formula" in record for record in records)
    header = (f"=== Sheet: {name} ===\nFormula cells: {count}; "
              f"nonempty value rows: {len(rows)}; blank value rows omitted: {len(all_rows) - len(rows)}.")
    return header, _formula_lines(records, calculated), grid_header, grid_rows


def _render_sheet(sections):
    header, formulas, grid_header, rows = sections
    parts = [header]
    if formulas:
        parts.extend(["Formula evidence:", "\n".join(formulas)])
    parts.extend(["Values (CSV; row numbers and column letters):", grid_header, "\n".join(rows)])
    return "\n".join(parts)


def format_sheets(sheets, result) -> str:
    """Render every nonempty value row and exact formula family on every sheet.

    Empty displayed rows are counted in the header; their formulas remain in
    the family evidence and ranges. No text budget omits rows or formula entries.
    """
    computed = result["cells"] if result is not None else {}
    return "\n".join(_render_sheet(_sheet_sections(name, records, computed.get(name, {})))
                     for name, records in sheets)

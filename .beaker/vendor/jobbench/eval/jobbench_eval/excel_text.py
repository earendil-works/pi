"""Compact spreadsheet text for the judge's bounded evidence prompt."""

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


def _allocate(lengths, budget):
    """Let small sheets fit completely, sharing the remainder across large ones."""
    assigned = [0] * len(lengths)
    pending = list(range(len(lengths)))
    while pending:
        share = max(0, budget // len(pending))
        small = [index for index in pending if lengths[index] <= share]
        if not small:
            for offset, index in enumerate(pending):
                assigned[index] = share + (offset < max(0, budget) % len(pending))
            break
        for index in small:
            assigned[index] = lengths[index]
            budget -= lengths[index]
            pending.remove(index)
    return assigned


def _fit_lines(lines, budget, label):
    """Keep whole head/tail entries and explicitly count the omitted middle."""
    full = "\n".join(lines)
    if len(full) <= budget:
        return full
    marker = f"[EXCEL TEXT TRUNCATED: {label}; omitted {len(lines)} of {len(lines)} entries]"
    available = budget - len(marker) - 2
    head, tail = [], []
    left, right = 0, len(lines) - 1
    take_head = True
    while left <= right:
        chosen = None
        for is_head in (take_head, not take_head):
            index = left if is_head else right
            if len(lines[index]) + 1 <= available:
                chosen = is_head
                break
        if chosen is None:
            break
        index = left if chosen else right
        (head if chosen else tail).append(lines[index])
        available -= len(lines[index]) + 1
        if chosen:
            left += 1
        else:
            right -= 1
        take_head = not chosen
    marker = f"[EXCEL TEXT TRUNCATED: {label}; omitted {right - left + 1} of {len(lines)} entries]"
    return "\n".join([*head, marker, *reversed(tail)])[:max(0, budget)]


def _render_sheet(sections, budget=None):
    header, formulas, grid_header, rows = sections

    def combine(formula_text, row_text):
        parts = [header]
        if formulas:
            parts.extend(["Formula evidence:", formula_text])
        parts.extend(["Values (CSV; row numbers and column letters):", grid_header, row_text])
        return "\n".join(parts)

    formula_text, row_text = "\n".join(formulas), "\n".join(rows)
    full = combine(formula_text, row_text)
    if budget is None or len(full) <= budget:
        return full
    remaining = budget - len(combine("", ""))
    if remaining < 90:
        title, statistics = header.split("\n", 1)
        body_budget = max(0, budget - len(title) - 1)
        body = _fit_lines([statistics, *formulas, grid_header, *rows], body_budget, "sheet entries")
        return (title + "\n" + body)[:max(0, budget)]
    # Compact families normally fit completely; unique formulas and values share
    # the space if neither can fit. Every sheet has its own reserved budget.
    if len(formula_text) <= remaining // 2:
        formula_budget = len(formula_text)
        row_budget = remaining - formula_budget
    else:
        formula_budget, row_budget = _allocate([len(formula_text), len(row_text)], remaining)
    return combine(_fit_lines(formulas, formula_budget, "formula entries"),
                   _fit_lines(rows, row_budget, "value rows"))


def format_sheets(sheets, result, *, max_chars=190000) -> str:
    """Render values and exact formula families without starving later sheets.

    Full per-cell audit records belong in the caller's diagnostics. Text budgets
    are shared between sheets; any omitted grid rows or formula entries carry an
    explicit marker. Empty displayed rows are omitted, with formulas retained in
    the family evidence and their ranges.
    """
    if (max_chars is not None and max_chars <= 0) or not sheets:
        return ""
    computed = result["cells"] if result is not None else {}
    sections = [_sheet_sections(name, records, computed.get(name, {})) for name, records in sheets]
    texts = [_render_sheet(section) for section in sections]
    if max_chars is None or sum(map(len, texts)) + len(texts) - 1 <= max_chars:
        return "\n".join(texts)
    budgets = _allocate(list(map(len, texts)), max(0, max_chars - len(texts) + 1))
    return "\n".join(_render_sheet(section, budget) for section, budget in zip(sections, budgets))[:max_chars]

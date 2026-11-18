"""Read conditional formats and native chart definitions without executing Excel."""

from __future__ import annotations

import json
import posixpath
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def read_objects(path: Path) -> list[str]:
    """Retain the actual OOXML rules, styles and chart definitions as evidence."""
    parts = []
    with ZipFile(path) as archive:
        def relationships(part):
            directory, name = posixpath.split(part)
            rels = posixpath.join(directory, "_rels", name + ".rels")
            if rels not in archive.namelist():
                return {}
            return {
                item.attrib["Id"]: (
                    item.attrib["Target"].lstrip("/") if item.attrib["Target"].startswith("/")
                    else posixpath.normpath(posixpath.join(directory, item.attrib["Target"]))
                )
                for item in ET.fromstring(archive.read(rels))
                if item.attrib.get("TargetMode") != "External"
            }

        book = ET.fromstring(archive.read("xl/workbook.xml"))
        targets = relationships("xl/workbook.xml")
        styles = ET.fromstring(archive.read("xl/styles.xml")) if "xl/styles.xml" in archive.namelist() else None
        dxfs = list(styles.find("{*}dxfs")) if styles is not None and styles.find("{*}dxfs") is not None else []
        for sheet in book.findall("{*}sheets/{*}sheet"):
            relation = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            sheet_path = targets.get(relation)
            if sheet_path is None:
                continue
            document = ET.fromstring(archive.read(sheet_path))
            sheet_name = sheet.attrib["name"]
            for formatting in document.findall("{*}conditionalFormatting"):
                for rule in formatting:
                    item = {"sheet": sheet_name, "range": formatting.attrib.get("sqref"),
                            "rule": ET.tostring(rule, encoding="unicode")}
                    if "dxfId" in rule.attrib:
                        index = int(rule.attrib["dxfId"])
                        if not 0 <= index < len(dxfs):
                            raise ValueError(f"Invalid conditional-format style {index} in {sheet_name}")
                        item["differential_style"] = ET.tostring(dxfs[index], encoding="unicode")
                    parts.append("Conditional formatting: " + json.dumps(item, ensure_ascii=False))
            for drawing in document.findall("{*}drawing"):
                relation = drawing.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                drawing_path = relationships(sheet_path).get(relation)
                if drawing_path is None:
                    continue
                drawing_document = ET.fromstring(archive.read(drawing_path))
                chart_targets = relationships(drawing_path)
                for chart in drawing_document.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/chart}chart"):
                    relation = chart.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                    chart_path = chart_targets.get(relation)
                    if chart_path is not None:
                        definition = ET.fromstring(archive.read(chart_path))
                        parts.append("Native chart: " + json.dumps({
                            "sheet": sheet_name, "part": chart_path,
                            "definition": ET.tostring(definition, encoding="unicode"),
                        }, ensure_ascii=False))
    if parts:
        parts.insert(0, "=== Excel object evidence ===\nOOXML definitions establish saved rules and chart structure, not a rendered visual appearance. RGB colors use ARGB hexadecimal notation.")
    return parts

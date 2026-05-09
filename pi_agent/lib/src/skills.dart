/// Skill loading and formatting utilities.
library;

import 'dart:io' as io;

import 'types.dart';

/// Loads skills from directories containing SKILL.md files.
///
/// Each SKILL.md should have YAML frontmatter with `name`, `description`,
/// and optional `invocation` and `hidden` fields.
Future<List<Skill>> loadSkills(
  List<String> directories, {
  bool followSymlinks = true,
}) async {
  final skills = <Skill>[];

  for (final dir in directories) {
    final directory = io.Directory(dir);
    if (!await directory.exists()) continue;

    await for (final entity in directory.list(
      followLinks: followSymlinks,
      recursive: true,
    )) {
      if (entity is io.File) {
        final basename = entity.path.split('/').last;
        if (basename.toLowerCase() == 'skill.md' ||
            basename.toLowerCase().endsWith('.skill.md')) {
          final skill = await _loadSkillFile(entity.path);
          if (skill != null) skills.add(skill);
        }
      }
    }
  }

  return skills;
}

/// Loads skills with source provenance tracking.
Future<List<Skill>> loadSourcedSkills<TSource>(
  List<({TSource source, String directory})> sourceDirs, {
  bool followSymlinks = true,
}) async {
  final skills = <Skill>[];

  for (final item in sourceDirs) {
    final loaded =
        await loadSkills([item.directory], followSymlinks: followSymlinks);
    skills.addAll(loaded);
  }

  return skills;
}

/// Formats a skill as invocation text.
String formatSkillInvocation(Skill skill) {
  final buffer = StringBuffer();
  buffer.writeln('# ${skill.name}');
  buffer.writeln();
  buffer.writeln(skill.description);
  if (skill.invocation != null) {
    buffer.writeln();
    buffer.writeln('Usage: ${skill.invocation}');
  }
  return buffer.toString();
}

/// Formats skills as an XML block for system prompts.
///
/// Generates `<available_skills>` XML with each non-hidden skill.
String formatSkillsForSystemPrompt(List<Skill> skills) {
  final visible = skills.where((s) => !s.hidden).toList();
  if (visible.isEmpty) return '';

  final buffer = StringBuffer();
  buffer.writeln('<available_skills>');

  for (final skill in visible) {
    buffer.writeln('  <skill>');
    buffer.writeln('    <name>${_escapeXml(skill.name)}</name>');
    buffer.writeln(
        '    <description>${_escapeXml(skill.description)}</description>');
    if (skill.invocation != null) {
      buffer.writeln(
          '    <invocation>${_escapeXml(skill.invocation!)}</invocation>');
    }
    buffer.writeln('    <location>${_escapeXml(skill.sourcePath)}</location>');
    buffer.writeln('  </skill>');
  }

  buffer.writeln('</available_skills>');
  return buffer.toString();
}

Future<Skill?> _loadSkillFile(String filePath) async {
  final file = io.File(filePath);
  if (!await file.exists()) return null;

  try {
    final content = await file.readAsString();
    final parsed = _parseFrontmatter(content);
    if (parsed == null) return null;

    final frontmatter = parsed.$1;
    final body = parsed.$2;

    final name = frontmatter['name'] as String?;
    final description = frontmatter['description'] as String?;
    if (name == null || description == null) return null;

    return Skill(
      name: name,
      description: description,
      content: body.trim(),
      invocation: frontmatter['invocation'] as String?,
      hidden: frontmatter['hidden'] == true,
      sourcePath: filePath,
    );
  } catch (e) {
    return null;
  }
}

(Map<String, dynamic>, String)? _parseFrontmatter(String content) {
  if (!content.startsWith('---')) return null;

  final endIndex = content.indexOf('---', 3);
  if (endIndex == -1) return null;

  final yamlStr = content.substring(3, endIndex).trim();
  final body = content.substring(endIndex + 3).trim();

  try {
    final yaml = _parseSimpleYaml(yamlStr);
    return (yaml, body);
  } catch (_) {
    return null;
  }
}

Map<String, dynamic> _parseSimpleYaml(String yaml) {
  final result = <String, dynamic>{};
  for (final line in yaml.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.isEmpty || trimmed.startsWith('#')) continue;
    final colonIndex = trimmed.indexOf(':');
    if (colonIndex == -1) continue;
    final key = trimmed.substring(0, colonIndex).trim();
    var value = trimmed.substring(colonIndex + 1).trim() as dynamic;
    if (value is String) {
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.substring(1, value.length - 1);
      } else if (value == 'true') {
        value = true;
      } else if (value == 'false') {
        value = false;
      }
    }
    result[key] = value;
  }
  return result;
}

String _escapeXml(String text) => text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

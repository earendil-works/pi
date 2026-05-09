/// Prompt template loading and argument substitution.
library;

import 'dart:io' as io;

import 'types.dart';

/// Loads prompt templates from .md files with YAML frontmatter.
Future<List<PromptTemplate>> loadPromptTemplates(List<String> paths) async {
  final templates = <PromptTemplate>[];

  for (final path in paths) {
    final entity = await io.FileSystemEntity.type(path);
    if (entity == io.FileSystemEntityType.file) {
      final template = await _loadTemplateFile(path);
      if (template != null) templates.add(template);
    } else if (entity == io.FileSystemEntityType.directory) {
      final dir = io.Directory(path);
      await for (final file in dir.list()) {
        if (file is io.File && file.path.endsWith('.md')) {
          final template = await _loadTemplateFile(file.path);
          if (template != null) templates.add(template);
        }
      }
    }
  }

  return templates;
}

/// Loads prompt templates with source provenance tracking.
Future<List<PromptTemplate>> loadSourcedPromptTemplates<TSource>(
  List<({TSource source, String path})> sourcePaths,
) async {
  final templates = <PromptTemplate>[];
  for (final item in sourcePaths) {
    final loaded = await loadPromptTemplates([item.path]);
    templates.addAll(loaded);
  }
  return templates;
}

/// Substitutes positional and named arguments into template content.
///
/// Supports: `$1`..`$N` (positional), `$@` (all args joined),
/// `$ARGUMENTS` (full raw input), `${@:N}` (args from position N).
String substituteArgs(String content, List<String> args) {
  var result = content;

  // ${@:N} - args from position N onward
  result = result.replaceAllMapped(
    RegExp(r'\$\{@:(\d+)\}'),
    (match) {
      final start = int.parse(match.group(1)!) - 1;
      if (start < 0 || start >= args.length) return '';
      return args.sublist(start).join(' ');
    },
  );

  // $ARGUMENTS - full raw input
  result = result.replaceAll('\$ARGUMENTS', args.join(' '));

  // $@ - all args joined
  result = result.replaceAll('\$@', args.join(' '));

  // $1..$N - positional args
  for (var i = 0; i < args.length; i++) {
    result = result.replaceAll('\$${i + 1}', args[i]);
  }

  return result;
}

/// Parses shell-style quoted arguments.
List<String> parseCommandArgs(String input) {
  final args = <String>[];
  final buffer = StringBuffer();
  var inSingleQuote = false;
  var inDoubleQuote = false;

  for (var i = 0; i < input.length; i++) {
    final ch = input[i];

    if (inSingleQuote) {
      if (ch == "'") {
        inSingleQuote = false;
      } else {
        buffer.write(ch);
      }
    } else if (inDoubleQuote) {
      if (ch == '"') {
        inDoubleQuote = false;
      } else if (ch == '\\' && i + 1 < input.length) {
        buffer.write(input[++i]);
      } else {
        buffer.write(ch);
      }
    } else {
      if (ch == "'") {
        inSingleQuote = true;
      } else if (ch == '"') {
        inDoubleQuote = true;
      } else if (ch == ' ' || ch == '\t') {
        if (buffer.isNotEmpty) {
          args.add(buffer.toString());
          buffer.clear();
        }
      } else {
        buffer.write(ch);
      }
    }
  }

  if (buffer.isNotEmpty) {
    args.add(buffer.toString());
  }

  return args;
}

/// Formats a prompt template with substituted arguments.
String formatPromptTemplateInvocation(
  PromptTemplate template, {
  List<String>? args,
  String? arguments,
}) {
  final effectiveArgs =
      args ?? (arguments != null ? parseCommandArgs(arguments) : <String>[]);
  return substituteArgs(template.content, effectiveArgs);
}

Future<PromptTemplate?> _loadTemplateFile(String filePath) async {
  final file = io.File(filePath);
  if (!await file.exists()) return null;

  try {
    final content = await file.readAsString();
    final parsed = _parseFrontmatter(content);
    if (parsed == null) {
      final name = filePath.split('/').last.replaceAll('.md', '');
      return PromptTemplate(
        name: name,
        description: '',
        content: content.trim(),
        sourcePath: filePath,
      );
    }

    final frontmatter = parsed.$1;
    final body = parsed.$2;

    return PromptTemplate(
      name: frontmatter['name'] as String? ??
          filePath.split('/').last.replaceAll('.md', ''),
      description: frontmatter['description'] as String? ?? '',
      content: body.trim(),
      args: (frontmatter['args'] as String?)
              ?.split(',')
              .map((s) => s.trim())
              .toList() ??
          [],
      sourcePath: filePath,
    );
  } catch (_) {
    return null;
  }
}

(Map<String, dynamic>, String)? _parseFrontmatter(String content) {
  if (!content.startsWith('---')) return null;

  final endIndex = content.indexOf('---', 3);
  if (endIndex == -1) return null;

  final yamlStr = content.substring(3, endIndex).trim();
  final body = content.substring(endIndex + 3).trim();

  final result = <String, dynamic>{};
  for (final line in yamlStr.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.isEmpty || trimmed.startsWith('#')) continue;
    final colonIndex = trimmed.indexOf(':');
    if (colonIndex == -1) continue;
    final key = trimmed.substring(0, colonIndex).trim();
    var value = trimmed.substring(colonIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.substring(1, value.length - 1);
    }
    result[key] = value;
  }

  return (result, body);
}

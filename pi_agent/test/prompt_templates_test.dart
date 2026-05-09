import 'dart:io' as io;

import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/prompt_templates.dart';

void main() {
  late String tempDir;

  setUp(() async {
    tempDir =
        '${io.Directory.systemTemp.path}/pi_agent_templates_test_${DateTime.now().microsecondsSinceEpoch}';
    await io.Directory(tempDir).create();
  });

  tearDown(() async {
    final dir = io.Directory(tempDir);
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  });

  group('substituteArgs', () {
    test(r'substitutes positional args $1..$N', () {
      final result = substituteArgs('Hello \$1, you are \$2', ['World', 'great']);
      expect(result, 'Hello World, you are great');
    });

    test(r'substitutes $@ with all args joined', () {
      final result = substituteArgs('Args: \$@', ['a', 'b', 'c']);
      expect(result, 'Args: a b c');
    });

    test(r'substitutes $ARGUMENTS with all args joined', () {
      final result = substituteArgs('Input: \$ARGUMENTS', ['x', 'y']);
      expect(result, 'Input: x y');
    });

    test(r'substitutes ${@:N} from position N', () {
      final result = substituteArgs('\${@:2}', ['a', 'b', 'c']);
      expect(result, 'b c');
    });

    test(r'handles out of range ${@:N}', () {
      final result = substituteArgs('\${@:10}', ['a', 'b']);
      expect(result, isEmpty);
    });

    test('handles empty args', () {
      final result = substituteArgs('No args: \$1', []);
      expect(result, 'No args: \$1');
    });

    test('handles multiple occurrences of same placeholder', () {
      final result = substituteArgs('\$1 and \$1', ['hello']);
      expect(result, 'hello and hello');
    });
  });

  group('parseCommandArgs', () {
    test('parses simple space-separated args', () {
      expect(parseCommandArgs('a b c'), ['a', 'b', 'c']);
    });

    test('parses double-quoted args', () {
      expect(parseCommandArgs('hello "world foo" bar'), [
        'hello',
        'world foo',
        'bar',
      ]);
    });

    test('parses single-quoted args', () {
      expect(parseCommandArgs("hello 'world foo' bar"), [
        'hello',
        'world foo',
        'bar',
      ]);
    });

    test('handles escaped chars in double quotes', () {
      expect(parseCommandArgs(r'hello "wor\"ld"'), ['hello', 'wor"ld']);
    });

    test('handles tabs as separators', () {
      expect(parseCommandArgs('a\tb\tc'), ['a', 'b', 'c']);
    });

    test('handles leading/trailing whitespace', () {
      expect(parseCommandArgs('  a b  '), ['a', 'b']);
    });

    test('handles empty string', () {
      expect(parseCommandArgs(''), isEmpty);
    });

    test('handles single arg', () {
      expect(parseCommandArgs('hello'), ['hello']);
    });
  });

  group('formatPromptTemplateInvocation', () {
    test('formats with args list', () {
      final template = PromptTemplate(
        name: 'test',
        description: 'Test template',
        content: 'Hello \$1',
        sourcePath: '/path',
      );
      final result = formatPromptTemplateInvocation(template, args: ['World']);
      expect(result, 'Hello World');
    });

    test('formats with arguments string', () {
      final template = PromptTemplate(
        name: 'test',
        description: 'Test template',
        content: 'Hello \$1 \$2',
        sourcePath: '/path',
      );
      final result =
          formatPromptTemplateInvocation(template, arguments: 'World Foo');
      expect(result, 'Hello World Foo');
    });
  });

  group('loadPromptTemplates', () {
    test('loads template from file', () async {
      final file = io.File('$tempDir/test.md');
      await file.writeAsString('''---
name: my-template
description: A test template
args: arg1, arg2
---
Hello \$1 and \$2.''');

      final templates = await loadPromptTemplates(['$tempDir/test.md']);
      expect(templates, hasLength(1));
      expect(templates.first.name, 'my-template');
      expect(templates.first.description, 'A test template');
      expect(templates.first.args, ['arg1', 'arg2']);
      expect(templates.first.content, 'Hello \$1 and \$2.');
    });

    test('loads template without frontmatter using filename', () async {
      final file = io.File('$tempDir/simple.md');
      await file.writeAsString('Just content.');

      final templates = await loadPromptTemplates(['$tempDir/simple.md']);
      expect(templates, hasLength(1));
      expect(templates.first.name, 'simple');
      expect(templates.first.content, 'Just content.');
    });

    test('loads templates from directory', () async {
      final file1 = io.File('$tempDir/a.md');
      await file1.writeAsString('Content A.');
      final file2 = io.File('$tempDir/b.md');
      await file2.writeAsString('Content B.');

      final templates = await loadPromptTemplates([tempDir]);
      expect(templates, hasLength(2));
    });

    test('returns empty for nonexistent path', () async {
      final templates = await loadPromptTemplates(['/nonexistent']);
      expect(templates, isEmpty);
    });

    test('ignores non-md files in directory', () async {
      final file = io.File('$tempDir/data.txt');
      await file.writeAsString('Not a template');

      final templates = await loadPromptTemplates([tempDir]);
      expect(templates, isEmpty);
    });
  });
}

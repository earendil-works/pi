import 'dart:io' as io;

import 'package:test/test.dart';
import 'package:pi/src/types.dart';
import 'package:pi/src/skills.dart';

void main() {
  late String tempDir;

  setUp(() async {
    tempDir =
        '${io.Directory.systemTemp.path}/pi_agent_skills_test_${DateTime.now().microsecondsSinceEpoch}';
    await io.Directory(tempDir).create();
  });

  tearDown(() async {
    final dir = io.Directory(tempDir);
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  });

  Future<void> writeSkillFile(String name, String content) async {
    final file = io.File('$tempDir/$name');
    await file.writeAsString(content);
  }

  group('loadSkills', () {
    test('loads skill from SKILL.md', () async {
      await writeSkillFile('SKILL.md', '''---
name: test-skill
description: A test skill
---
Skill content here.''');

      final skills = await loadSkills([tempDir]);
      expect(skills, hasLength(1));
      expect(skills.first.name, 'test-skill');
      expect(skills.first.description, 'A test skill');
      expect(skills.first.content, 'Skill content here.');
    });

    test('loads skill from .skill.md file', () async {
      await writeSkillFile('my-tool.skill.md', '''---
name: my-tool
description: My tool
---
Tool content.''');

      final skills = await loadSkills([tempDir]);
      expect(skills, hasLength(1));
      expect(skills.first.name, 'my-tool');
    });

    test('loads hidden skill', () async {
      await writeSkillFile('SKILL.md', '''---
name: hidden-skill
description: Hidden
hidden: true
---
Content.''');

      final skills = await loadSkills([tempDir]);
      expect(skills, hasLength(1));
      expect(skills.first.hidden, isTrue);
    });

    test('loads skill with invocation', () async {
      await writeSkillFile('SKILL.md', '''---
name: my-skill
description: Test
invocation: /skill <args>
---
Body.''');

      final skills = await loadSkills([tempDir]);
      expect(skills.first.invocation, '/skill <args>');
    });

    test('skips file without frontmatter', () async {
      await writeSkillFile('SKILL.md', 'No frontmatter here.');
      final skills = await loadSkills([tempDir]);
      expect(skills, isEmpty);
    });

    test('skips file missing name', () async {
      await writeSkillFile('SKILL.md', '''---
description: No name
---
Content.''');
      final skills = await loadSkills([tempDir]);
      expect(skills, isEmpty);
    });

    test('skips file missing description', () async {
      await writeSkillFile('SKILL.md', '''---
name: no-desc
---
Content.''');
      final skills = await loadSkills([tempDir]);
      expect(skills, isEmpty);
    });

    test('returns empty for nonexistent directory', () async {
      final skills = await loadSkills(['/nonexistent/path']);
      expect(skills, isEmpty);
    });

    test('loads from multiple directories', () async {
      final dir2 =
          '${io.Directory.systemTemp.path}/pi_agent_skills_test2_${DateTime.now().microsecondsSinceEpoch}';
      await io.Directory(dir2).create();

      await writeSkillFile('SKILL.md', '''---
name: skill1
description: First
---
One.''');

      final file2 = io.File('$dir2/SKILL.md');
      await file2.writeAsString('''---
name: skill2
description: Second
---
Two.''');

      final skills = await loadSkills([tempDir, dir2]);
      expect(skills, hasLength(2));

      await io.Directory(dir2).delete(recursive: true);
    });

    test('ignores non-SKILL.md files', () async {
      await writeSkillFile('README.md', 'Not a skill');
      final skills = await loadSkills([tempDir]);
      expect(skills, isEmpty);
    });

    test('handles quoted string values', () async {
      await writeSkillFile('SKILL.md', '''---
name: "quoted-name"
description: 'quoted desc'
---
Content.''');

      final skills = await loadSkills([tempDir]);
      expect(skills, hasLength(1));
      expect(skills.first.name, 'quoted-name');
      expect(skills.first.description, 'quoted desc');
    });
  });

  group('formatSkillInvocation', () {
    test('formats skill name and description', () {
      final skill = Skill(
        name: 'my-skill',
        description: 'Does things',
        content: 'body',
        sourcePath: '/path',
      );
      final result = formatSkillInvocation(skill);
      expect(result, contains('my-skill'));
      expect(result, contains('Does things'));
    });

    test('includes invocation when present', () {
      final skill = Skill(
        name: 'my-skill',
        description: 'Desc',
        content: 'body',
        invocation: '/skill <arg>',
        sourcePath: '/path',
      );
      final result = formatSkillInvocation(skill);
      expect(result, contains('/skill <arg>'));
    });

    test('omits invocation line when null', () {
      final skill = Skill(
        name: 'my-skill',
        description: 'Desc',
        content: 'body',
        sourcePath: '/path',
      );
      final result = formatSkillInvocation(skill);
      expect(result, isNot(contains('Usage:')));
    });
  });

  group('formatSkillsForSystemPrompt', () {
    test('returns empty string for empty list', () {
      expect(formatSkillsForSystemPrompt([]), isEmpty);
    });

    test('formats visible skills as XML', () {
      final skills = [
        Skill(
          name: 'skill1',
          description: 'First skill',
          content: 'body',
          sourcePath: '/path1',
        ),
      ];
      final result = formatSkillsForSystemPrompt(skills);
      expect(result, contains('<available_skills>'));
      expect(result, contains('</available_skills>'));
      expect(result, contains('<name>skill1</name>'));
      expect(result, contains('<description>First skill</description>'));
      expect(result, contains('<location>/path1</location>'));
    });

    test('includes invocation when present', () {
      final skills = [
        Skill(
          name: 'skill1',
          description: 'Desc',
          content: 'body',
          invocation: '/cmd',
          sourcePath: '/path',
        ),
      ];
      final result = formatSkillsForSystemPrompt(skills);
      expect(result, contains('<invocation>/cmd</invocation>'));
    });

    test('hides hidden skills', () {
      final skills = [
        Skill(
          name: 'visible',
          description: 'Visible',
          content: 'body',
          sourcePath: '/p1',
        ),
        Skill(
          name: 'hidden',
          description: 'Hidden',
          content: 'body',
          hidden: true,
          sourcePath: '/p2',
        ),
      ];
      final result = formatSkillsForSystemPrompt(skills);
      expect(result, contains('visible'));
      expect(result, isNot(contains('hidden')));
    });

    test('escapes XML special characters', () {
      final skills = [
        Skill(
          name: 'a<b>&c',
          description: 'd"e\'f',
          content: 'body',
          sourcePath: '/path',
        ),
      ];
      final result = formatSkillsForSystemPrompt(skills);
      expect(result, contains('a&lt;b&gt;&amp;c'));
      expect(result, contains('d&quot;e&apos;f'));
    });
  });
}

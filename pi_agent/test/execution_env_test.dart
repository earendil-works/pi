import 'dart:io' as io;

import 'package:test/test.dart';
import 'package:pi/src/execution_env.dart';

void main() {
  group('FileError', () {
    test('formats toString', () {
      const error = FileError(
        path: '/foo',
        code: FileErrorCode.notFound,
        message: 'File not found',
      );
      expect(error.toString(), contains('notFound'));
      expect(error.toString(), contains('/foo'));
    });
  });

  group('ShellResult', () {
    test('success is true for exit code 0', () {
      const result = ShellResult(stdout: '', stderr: '', exitCode: 0);
      expect(result.success, isTrue);
    });

    test('success is false for non-zero exit code', () {
      const result = ShellResult(stdout: '', stderr: '', exitCode: 1);
      expect(result.success, isFalse);
    });
  });

  group('LocalExecutionEnv', () {
    late LocalExecutionEnv env;
    late String tempDir;

    setUp(() async {
      env = LocalExecutionEnv();
      tempDir = '${io.Directory.systemTemp.path}/pi_agent_env_test_${DateTime.now().microsecondsSinceEpoch}';
      await io.Directory(tempDir).create();
    });

    tearDown(() async {
      final dir = io.Directory(tempDir);
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    });

    test('writeFile and readFile', () async {
      final path = '$tempDir/test.txt';
      await env.writeFile(path, 'hello world');
      final content = await env.readFile(path);
      expect(content, 'hello world');
    });

    test('readFile throws for missing file', () async {
      expect(
        () => env.readFile('$tempDir/missing.txt'),
        throwsA(isA<FileError>()),
      );
    });

    test('listDirectory returns entries', () async {
      await env.writeFile('$tempDir/a.txt', 'a');
      await env.writeFile('$tempDir/b.txt', 'b');
      final entries = await env.listDirectory(tempDir);
      expect(entries, hasLength(2));
    });

    test('listDirectory throws for missing dir', () async {
      expect(
        () => env.listDirectory('$tempDir/missing'),
        throwsA(isA<FileError>()),
      );
    });

    test('removeFile deletes file', () async {
      final path = '$tempDir/toRemove.txt';
      await env.writeFile(path, 'data');
      expect(await env.fileExists(path), isTrue);
      await env.removeFile(path);
      expect(await env.fileExists(path), isFalse);
    });

    test('removeFile throws for missing file', () async {
      expect(
        () => env.removeFile('$tempDir/missing.txt'),
        throwsA(isA<FileError>()),
      );
    });

    test('fileInfo returns metadata', () async {
      final path = '$tempDir/info.txt';
      await env.writeFile(path, 'content');
      final info = await env.fileInfo(path);
      expect(info.path, path);
      expect(info.kind, FileKind.file);
      expect(info.size, greaterThan(0));
    });

    test('fileInfo throws for missing file', () async {
      expect(
        () => env.fileInfo('$tempDir/missing.txt'),
        throwsA(isA<FileError>()),
      );
    });

    test('fileExists returns correct boolean', () async {
      final path = '$tempDir/exists.txt';
      expect(await env.fileExists(path), isFalse);
      await env.writeFile(path, 'yes');
      expect(await env.fileExists(path), isTrue);
    });

    test('exec runs shell command', () async {
      final result = await env.exec('echo hello');
      expect(result.stdout.trim(), 'hello');
      expect(result.success, isTrue);
    });

    test('exec captures stderr', () async {
      final result = await env.exec('echo error >&2');
      expect(result.stderr.trim(), 'error');
    });

    test('exec captures exit code', () async {
      final result = await env.exec('exit 42');
      expect(result.exitCode, 42);
      expect(result.success, isFalse);
    });

    test('exec with workingDirectory', () async {
      final result = await env.exec('pwd', workingDirectory: tempDir);
      expect(result.stdout.trim(), contains('pi_agent_env_test_'));
    });

    test('createTempFile creates a file', () async {
      final path = await env.createTempFile(prefix: 'test_', suffix: '.txt');
      expect(await io.File(path).exists(), isTrue);
      await io.File(path).delete();
    });

    test('createTempDirectory creates a directory', () async {
      final path = await env.createTempDirectory(prefix: 'testdir_');
      expect(await io.Directory(path).exists(), isTrue);
      await io.Directory(path).delete();
    });
  });

  group('truncateHead', () {
    test('keeps first N lines', () {
      final text = List.generate(10, (i) => 'line $i').join('\n');
      final result = truncateHead(text, maxLines: 3);
      expect(result.split('\n'), hasLength(3));
      expect(result, contains('line 0'));
    });

    test('keeps first N bytes', () {
      final text = 'a' * 100;
      final result = truncateHead(text, maxLines: 1000, maxBytes: 10);
      expect(result.length, 10);
    });

    test('returns full text if within limits', () {
      final text = 'short';
      final result = truncateHead(text);
      expect(result, text);
    });
  });

  group('truncateTail', () {
    test('keeps last N lines', () {
      final text = List.generate(10, (i) => 'line $i').join('\n');
      final result = truncateTail(text, maxLines: 3);
      expect(result.split('\n'), hasLength(3));
      expect(result, contains('line 9'));
    });

    test('keeps last N bytes', () {
      final text = 'a' * 100;
      final result = truncateTail(text, maxLines: 1000, maxBytes: 10);
      expect(result.length, 10);
    });
  });

  group('formatSize', () {
    test('formats bytes', () {
      expect(formatSize(512), '512 B');
    });

    test('formats kilobytes', () {
      expect(formatSize(1536), '1.5KB');
    });

    test('formats megabytes', () {
      expect(formatSize(2 * 1024 * 1024), '2.0MB');
    });
  });
}

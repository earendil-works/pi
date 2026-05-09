/// Tool definitions and parameter validation.
library;

import 'dart:async';

import 'types.dart';

/// A tool definition for the agent.
///
/// Tools define functions the LLM can call during conversation.
/// Each tool has a JSON Schema for its parameters, an execute function,
/// and optional hooks for argument preparation and execution mode override.
class AgentTool<TParameters, TDetails> {
  /// Tool name (used by the LLM to reference this tool).
  final String name;

  /// Tool description (shown to the LLM).
  final String description;

  /// JSON Schema describing the tool's parameters.
  final Map<String, dynamic> parameters;

  /// Display label for UI rendering.
  final String label;

  /// Optional argument pre-processing function.
  final Map<String, dynamic>? Function(Map<String, dynamic> args)?
      prepareArguments;

  /// Tool execution function.
  final Future<AgentToolResult<TDetails>> Function(
    String toolCallId,
    Map<String, dynamic> params, {
    void Function(TDetails)? onUpdate,
    bool Function()? isAborted,
  }) execute;

  /// Per-tool execution mode override.
  final ToolExecutionMode? executionMode;

  /// Creates an agent tool.
  const AgentTool({
    required this.name,
    required this.description,
    required this.parameters,
    this.label = '',
    required this.execute,
    this.prepareArguments,
    this.executionMode,
  });

  /// Converts to the tool definition format expected by LLM APIs.
  Map<String, dynamic> toApiFormat() => {
        'type': 'function',
        'function': {
          'name': name,
          'description': description,
          'parameters': parameters,
        },
      };
}

/// Validates parameters against a JSON Schema.
///
/// Returns null if valid, or a list of error messages if invalid.
/// Supports: type, properties, required, enum, items.
List<String>? validateParameters(
  Map<String, dynamic> schema,
  Map<String, dynamic> values,
) {
  final errors = <String>[];

  _validateObject(schema, values, '', errors);

  return errors.isEmpty ? null : errors;
}

void _validateObject(
  Map<String, dynamic> schema,
  Map<String, dynamic> values,
  String path,
  List<String> errors,
) {
  final type = schema['type'];
  if (type != 'object') return;

  final properties = schema['properties'] as Map<String, dynamic>?;
  final required = schema['required'] as List<dynamic>?;

  if (required != null) {
    for (final field in required) {
      if (!values.containsKey(field)) {
        errors.add(
            '${path.isEmpty ? '' : '$path.'}$field: required field missing');
      }
    }
  }

  if (properties != null) {
    for (final entry in properties.entries) {
      final fieldName = entry.key;
      final fieldSchema = entry.value as Map<String, dynamic>;
      if (values.containsKey(fieldName)) {
        _validateValue(
          fieldSchema,
          values[fieldName],
          '${path.isEmpty ? '' : '$path.'}$fieldName',
          errors,
        );
      }
    }
  }

  final additionalProperties = schema['additionalProperties'];
  if (additionalProperties is bool && !additionalProperties) {
    final allowedKeys = properties?.keys.toSet() ?? <String>{};
    for (final key in values.keys) {
      if (!allowedKeys.contains(key)) {
        errors.add('$path.$key: additional property not allowed');
      }
    }
  }
}

void _validateValue(
  Map<String, dynamic> schema,
  dynamic value,
  String path,
  List<String> errors,
) {
  final type = schema['type'] as String?;

  if (type != null && !_checkType(type, value)) {
    errors.add('$path: expected $type, got ${_typeName(value)}');
    return;
  }

  if (schema.containsKey('enum')) {
    final enumValues = schema['enum'] as List<dynamic>;
    if (!enumValues.contains(value)) {
      errors.add('$path: value must be one of $enumValues');
    }
  }

  if (type == 'object' && value is Map<String, dynamic>) {
    _validateObject(schema, value, path, errors);
  }

  if (type == 'array' && value is List) {
    final items = schema['items'] as Map<String, dynamic>?;
    if (items != null) {
      for (var i = 0; i < value.length; i++) {
        _validateValue(items, value[i], '$path[$i]', errors);
      }
    }
  }

  if (schema.containsKey('minimum') && value is num) {
    final minimum = schema['minimum'] as num;
    if (value < minimum) {
      errors.add('$path: value $value is less than minimum $minimum');
    }
  }

  if (schema.containsKey('maximum') && value is num) {
    final maximum = schema['maximum'] as num;
    if (value > maximum) {
      errors.add('$path: value $value is greater than maximum $maximum');
    }
  }

  if (schema.containsKey('minLength') && value is String) {
    final minLength = schema['minLength'] as int;
    if (value.length < minLength) {
      errors.add(
          '$path: string length ${value.length} is less than minLength $minLength');
    }
  }

  if (schema.containsKey('maxLength') && value is String) {
    final maxLength = schema['maxLength'] as int;
    if (value.length > maxLength) {
      errors.add(
          '$path: string length ${value.length} exceeds maxLength $maxLength');
    }
  }
}

bool _checkType(String type, dynamic value) => switch (type) {
      'string' => value is String,
      'number' => value is num,
      'integer' => value is int,
      'boolean' => value is bool,
      'array' => value is List,
      'object' => value is Map,
      'null' => value == null,
      _ => true,
    };

String _typeName(dynamic value) => switch (value) {
      null => 'null',
      String() => 'string',
      int() => 'integer',
      double() => 'number',
      bool() => 'boolean',
      List() => 'array',
      Map() => 'object',
      _ => value.runtimeType.toString(),
    };

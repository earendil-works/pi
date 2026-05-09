/// SSE (Server-Sent Events) stream parser.
library;

import 'dart:async';
import 'dart:convert';

/// Parses a byte stream into SSE events.
///
/// Each event is emitted as a map with optional keys: `data`, `event`, `id`, `retry`.
/// Handles multi-line data, comment lines (starting with `:`), and chunked input.
Stream<Map<String, String>> parseSSE(Stream<List<int>> byteStream) {
  String dataBuffer = '';
  String eventType = '';
  String? lastEventId;
  String? retry;

  return byteStream
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .transform(
        StreamTransformer<String, Map<String, String>>.fromHandlers(
          handleData: (String line, EventSink<Map<String, String>> sink) {
            if (line.isEmpty) {
              if (dataBuffer.isNotEmpty) {
                final event = <String, String>{};
                if (dataBuffer.isNotEmpty) event['data'] = dataBuffer;
                if (eventType.isNotEmpty) event['event'] = eventType;
                if (lastEventId != null) event['id'] = lastEventId!;
                if (retry != null) event['retry'] = retry!;
                sink.add(event);
                dataBuffer = '';
                eventType = '';
              }
              return;
            }

            if (line.startsWith(':')) return;

            if (line.startsWith('data:')) {
              final data = line.substring(5);
              final trimmed = data.startsWith(' ') ? data.substring(1) : data;
              if (dataBuffer.isNotEmpty) dataBuffer += '\n';
              dataBuffer += trimmed;
            } else if (line.startsWith('event:')) {
              eventType = line.substring(6).trim();
            } else if (line.startsWith('id:')) {
              lastEventId = line.substring(3).trim();
            } else if (line.startsWith('retry:')) {
              retry = line.substring(6).trim();
            }
          },
          handleDone: (EventSink<Map<String, String>> sink) {
            if (dataBuffer.isNotEmpty) {
              final event = <String, String>{'data': dataBuffer};
              if (eventType.isNotEmpty) event['event'] = eventType;
              if (lastEventId != null) event['id'] = lastEventId!;
              sink.add(event);
            }
            sink.close();
          },
        ),
      );
}

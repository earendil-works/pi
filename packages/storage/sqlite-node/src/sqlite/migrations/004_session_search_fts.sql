CREATE VIRTUAL TABLE session_search_fts USING fts5(
	session_id UNINDEXED,
	entry_id UNINDEXED,
	role UNINDEXED,
	kind UNINDEXED,
	timestamp UNINDEXED,
	text,
	tokenize = 'trigram'
);

INSERT INTO session_search_fts(session_id, entry_id, role, kind, timestamp, text)
SELECT session_id, id, 'meta', 'name', timestamp,
	json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.name')
FROM session_entries
WHERE type = 'session_info'
	AND COALESCE(
		json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.name'),
		''
	) <> '';

INSERT INTO session_search_fts(session_id, entry_id, role, kind, timestamp, text)
SELECT session_id, id,
	json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.message.role'),
	'text', timestamp,
	json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.message.content')
FROM session_entries
WHERE type = 'message'
	AND json_type(
		CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
		'$.message.content'
	) = 'text'
	AND COALESCE(
		json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.message.content'),
		''
	) <> '';

INSERT INTO session_search_fts(session_id, entry_id, role, kind, timestamp, text)
SELECT e.session_id, e.id,
	json_extract(e.payload, '$.message.role'),
	CASE json_extract(part.value, '$.type')
		WHEN 'text' THEN 'text'
		WHEN 'thinking' THEN 'thinking'
		ELSE 'toolCall'
	END,
	e.timestamp,
	CASE json_extract(part.value, '$.type')
		WHEN 'text' THEN json_extract(part.value, '$.text')
		WHEN 'thinking' THEN json_extract(part.value, '$.thinking')
		ELSE trim(
			COALESCE(json_extract(part.value, '$.name'), '') || ' ' ||
			COALESCE(json_extract(part.value, '$.arguments'), '')
		)
	END
FROM session_entries e
JOIN json_each(
	CASE WHEN json_valid(e.payload) THEN
		CASE WHEN json_type(e.payload, '$.message.content') = 'array' THEN e.payload ELSE '{}' END
	ELSE '{}' END,
	'$.message.content'
) AS part
WHERE e.type = 'message'
	AND json_extract(part.value, '$.type') IN ('text', 'thinking', 'toolCall')
	AND CASE json_extract(part.value, '$.type')
		WHEN 'text' THEN COALESCE(json_extract(part.value, '$.text'), '')
		WHEN 'thinking' THEN COALESCE(json_extract(part.value, '$.thinking'), '')
		ELSE trim(
			COALESCE(json_extract(part.value, '$.name'), '') || ' ' ||
			COALESCE(json_extract(part.value, '$.arguments'), '')
		)
	END <> '';

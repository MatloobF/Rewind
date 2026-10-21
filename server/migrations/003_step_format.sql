-- Which API format an llm step's request and response are in: 'openai'
-- (/v1/chat/completions) or 'anthropic' (/v1/messages). Readers use it to
-- know how to read the JSON, and replay only stands in a parent step of the
-- same format. Tool steps (MCP) have no format.

ALTER TABLE steps ADD COLUMN format TEXT CHECK (format IN ('openai', 'anthropic'));

-- Every llm step so far came through the OpenAI-format route.
UPDATE steps SET format = 'openai' WHERE type = 'llm';

ALTER TABLE steps ADD CHECK ((type = 'llm') = (format IS NOT NULL));

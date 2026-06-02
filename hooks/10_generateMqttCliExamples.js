const UUID_SAMPLE = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// JSON Pointer / $ref helpers
// ---------------------------------------------------------------------------

function decodePointerToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    return null;
  }

  const parts = ref
    .slice(2)
    .split('/')
    .map(decodePointerToken);

  let current = doc;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return null;
    }
    current = current[part];
  }

  return current;
}

// ---------------------------------------------------------------------------
// Shell / MQTT helpers
// ---------------------------------------------------------------------------

function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseHostAndPort(hostValue) {
  const fallback = { host: 'localhost', port: null };
  if (typeof hostValue !== 'string' || hostValue.trim() === '') {
    return fallback;
  }

  const input = hostValue.trim();

  if (input.startsWith('[')) {
    const closingBracket = input.indexOf(']');
    if (closingBracket === -1) {
      return { host: input, port: null };
    }

    const host = input.slice(1, closingBracket);
    const remainder = input.slice(closingBracket + 1);
    if (remainder.startsWith(':')) {
      const port = remainder.slice(1);
      if (/^\d+$/.test(port)) {
        return { host, port };
      }
    }

    return { host, port: null };
  }

  const firstColon = input.indexOf(':');
  const lastColon = input.lastIndexOf(':');
  if (firstColon !== -1 && firstColon === lastColon) {
    const host = input.slice(0, firstColon);
    const port = input.slice(firstColon + 1);
    if (host && /^\d+$/.test(port)) {
      return { host, port };
    }
  }

  return { host: input, port: null };
}

function getMqttConnection(documentRoot) {
  const servers = documentRoot?.servers;
  if (!servers || typeof servers !== 'object') {
    return { host: 'localhost', port: null };
  }

  for (const server of Object.values(servers)) {
    if (!server || typeof server !== 'object') {
      continue;
    }

    if (server.protocol === 'mqtt' || server.protocol === 'mqtts') {
      return parseHostAndPort(server.host);
    }
  }

  return { host: 'localhost', port: null };
}

// ---------------------------------------------------------------------------
// Channel / message resolution (works on parser-resolved _json)
// ---------------------------------------------------------------------------

function getOperationChannel(operation) {
  if (!operation?.channel) {
    return null;
  }

  if (operation.channel.address) {
    return operation.channel;
  }

  return null;
}

function getReplyChannel(operation) {
  const reply = operation?.reply;
  if (!reply?.channel) {
    return null;
  }

  if (reply.channel.address) {
    return reply.channel;
  }

  return null;
}

function getFirstMessage(operation) {
  if (!Array.isArray(operation?.messages) || operation.messages.length === 0) {
    return null;
  }

  const msg = operation.messages[0];
  return msg && typeof msg === 'object' ? msg : null;
}

// ---------------------------------------------------------------------------
// Schema sampling (used to build the mosquitto_pub -m payload)
// ---------------------------------------------------------------------------

function extractMessageExamplePayload(messageObject) {
  if (!messageObject || typeof messageObject !== 'object') {
    return null;
  }

  const examples = messageObject.examples;
  if (!Array.isArray(examples) || examples.length === 0) {
    return null;
  }

  const candidate = examples[0];
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(candidate, 'payload')) {
    return candidate.payload;
  }

  return null;
}

function inferType(schema) {
  if (typeof schema.type === 'string') {
    return schema.type;
  }

  if (schema.properties || schema.additionalProperties) {
    return 'object';
  }

  if (schema.items) {
    return 'array';
  }

  return null;
}

function mergeAllOfValues(values) {
  const objectValues = values.filter(v => v && typeof v === 'object' && !Array.isArray(v));
  if (objectValues.length === values.length && values.length > 0) {
    return Object.assign({}, ...objectValues);
  }

  return values.find(v => v !== null && v !== undefined) ?? null;
}

function sampleFromSchema(schema, documentRoot, depth = 0, seenRefs = new Set()) {
  if (!schema || typeof schema !== 'object' || depth > 6) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'example')) {
    return schema.example;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return schema.const;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (schema.$ref) {
    if (seenRefs.has(schema.$ref)) {
      return null;
    }

    const nextSeen = new Set(seenRefs);
    nextSeen.add(schema.$ref);
    const resolved = resolveRef(documentRoot, schema.$ref);
    return sampleFromSchema(resolved, documentRoot, depth + 1, nextSeen);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const values = schema.allOf
      .map(item => sampleFromSchema(item, documentRoot, depth + 1, seenRefs))
      .filter(item => item !== undefined);
    return mergeAllOfValues(values);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return sampleFromSchema(schema.oneOf[0], documentRoot, depth + 1, seenRefs);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return sampleFromSchema(schema.anyOf[0], documentRoot, depth + 1, seenRefs);
  }

  const type = inferType(schema);

  if (type === 'object') {
    const output = {};
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required)
      ? new Set(schema.required)
      : null;

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (required && !required.has(propertyName) && depth > 1) {
        continue;
      }

      const value = sampleFromSchema(propertySchema, documentRoot, depth + 1, seenRefs);
      output[propertyName] = value;
    }

    if (
      Object.keys(output).length === 0 &&
      schema.additionalProperties &&
      typeof schema.additionalProperties === 'object'
    ) {
      output.example = sampleFromSchema(schema.additionalProperties, documentRoot, depth + 1, seenRefs);
    }

    return output;
  }

  if (type === 'array') {
    const item = sampleFromSchema(schema.items, documentRoot, depth + 1, seenRefs);
    return [item];
  }

  if (type === 'string') {
    if (schema.format === 'uuid') {
      return UUID_SAMPLE;
    }
    if (schema.format === 'date-time') {
      return '2026-01-01T00:00:00Z';
    }
    if (schema.format === 'date') {
      return '2026-01-01';
    }
    return 'string';
  }

  if (type === 'integer') {
    return 0;
  }

  if (type === 'number') {
    return 0;
  }

  if (type === 'boolean') {
    return true;
  }

  if (type === 'null') {
    return null;
  }

  return null;
}

function pruneValue(value) {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const items = value
      .map(item => pruneValue(item))
      .filter(item => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === 'object') {
    const output = {};
    for (const [key, childValue] of Object.entries(value)) {
      const pruned = pruneValue(childValue);
      if (pruned !== undefined) {
        output[key] = pruned;
      }
    }
    return Object.keys(output).length > 0 ? output : undefined;
  }

  return value;
}

function buildRequestPayload(messageObject, documentRoot) {
  const fromExample = extractMessageExamplePayload(messageObject);

  let payload;
  if (fromExample !== null && fromExample !== undefined) {
    payload = fromExample;
  } else {
    payload = sampleFromSchema(messageObject?.payload, documentRoot);
  }

  const prunedPayload = pruneValue(payload);

  if (!prunedPayload || typeof prunedPayload !== 'object' || Array.isArray(prunedPayload)) {
    return { id: UUID_SAMPLE };
  }

  if (!Object.prototype.hasOwnProperty.call(prunedPayload, 'id')) {
    prunedPayload.id = UUID_SAMPLE;
  }

  return prunedPayload;
}

// ---------------------------------------------------------------------------
// Build the MQTT CLI markdown block for operation.description
// ---------------------------------------------------------------------------

function buildMqttCliMarkdown(operation, documentRoot, mqttConnection) {
  const channel = getOperationChannel(operation);
  const replyChannel = getReplyChannel(operation);

  const requestTopic = channel?.address;
  const responseTopic = replyChannel?.address;

  const action = operation?.action;
  if (!requestTopic || !action) {
    return null;
  }

  const message = getFirstMessage(operation);
  const requestPayload = buildRequestPayload(message, documentRoot);
  const payloadAsJson = JSON.stringify(requestPayload);
  const payloadArg = shellQuoteSingle(payloadAsJson);
  const hostArgs = mqttConnection.port
    ? `-h ${mqttConnection.host} -p ${mqttConnection.port}`
    : `-h ${mqttConnection.host}`;

  const lines = [];

  if (action === 'send') {
    if (responseTopic) {
      lines.push('# Subscribe for the response (-C 1 exits after the first message)');
      lines.push(`mosquitto_sub ${hostArgs} -C 1 -F "%J" -t "${responseTopic}" | jq &`);
      lines.push('');
    }

    lines.push('# Publish the request');
    lines.push(`mosquitto_pub ${hostArgs} -t "${requestTopic}" -m ${payloadArg}`);
  } else if (action === 'receive') {
    lines.push('# Subscribe (-C 1 exits after the first message)');
    lines.push(`mosquitto_sub ${hostArgs} -C 1 -F "%J" -t "${requestTopic}" | jq &`);
    lines.push('');
    lines.push('# Publish a sample message');
    lines.push(`mosquitto_pub ${hostArgs} -t "${requestTopic}" -m ${payloadArg}`);
  } else {
    return null;
  }

  return [
    '#### Usage Example',
    '',
    '```bash',
    ...lines,
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

module.exports = {
  'generate:before': ({ asyncapi, templateParams = {} }) => {
    const mqttCliExamplesEnabled =
      templateParams.mqttCliExamples === true ||
      templateParams.mqttCliExamples === 'true';

    const documentRoot = asyncapi?._json;
    if (
      !documentRoot ||
      typeof documentRoot !== 'object' ||
      typeof documentRoot.operations !== 'object'
    ) {
      return;
    }

    if (!mqttCliExamplesEnabled) {
      return;
    }

    const mqttConnection = getMqttConnection(documentRoot);

    for (const [operationId, operation] of Object.entries(documentRoot.operations)) {
      if (!operation || typeof operation !== 'object') {
        continue;
      }

      const cliBlock = buildMqttCliMarkdown(operation, documentRoot, mqttConnection);
      if (!cliBlock) {
        continue;
      }

      // Append the CLI example to the operation description so it renders
      // directly in the left panel, always visible without any clicks.
      const currentDesc = typeof operation.description === 'string'
        ? operation.description.trimEnd()
        : '';

      operation.description = currentDesc
        ? `${currentDesc}\n\n${cliBlock}`
        : cliBlock;
    }
  },
};

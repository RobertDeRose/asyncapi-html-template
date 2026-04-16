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
// Schema sampling
// ---------------------------------------------------------------------------

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
  if (!schema || typeof schema !== 'object' || depth > 8) {
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

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
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

// ---------------------------------------------------------------------------
// allOf flattening - merge allOf sub-schemas into a single flat schema
// ---------------------------------------------------------------------------

function flattenAllOf(schema, documentRoot, depth = 0, seenRefs = new Set()) {
  if (!schema || typeof schema !== 'object' || depth > 8) {
    return schema;
  }

  // Resolve $ref first
  if (schema.$ref && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    if (seenRefs.has(schema.$ref)) return schema;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(schema.$ref);
    const resolved = resolveRef(documentRoot, schema.$ref);
    if (resolved) {
      return flattenAllOf(resolved, documentRoot, depth + 1, nextSeen);
    }
    return schema;
  }

  // Recursively flatten allOf
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged = {};
    const mergedProperties = {};
    const mergedRequired = [];

    for (let sub of schema.allOf) {
      sub = flattenAllOf(sub, documentRoot, depth + 1, seenRefs);
      if (!sub || typeof sub !== 'object') continue;

      for (const [key, value] of Object.entries(sub)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const [propName, propSchema] of Object.entries(value)) {
            // Later allOf entries override earlier ones (more specific wins)
            mergedProperties[propName] = flattenAllOf(propSchema, documentRoot, depth + 1, seenRefs);
          }
        } else if (key === 'required' && Array.isArray(value)) {
          mergedRequired.push(...value);
        } else if (key === 'allOf') {
          // skip nested allOf key itself (already processed)
        } else {
          merged[key] = value;
        }
      }
    }

    // Preserve non-allOf keys from the original schema
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'allOf') continue;
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [propName, propSchema] of Object.entries(value)) {
          if (!(propName in mergedProperties)) {
            mergedProperties[propName] = flattenAllOf(propSchema, documentRoot, depth + 1, seenRefs);
          }
        }
      } else if (key === 'required' && Array.isArray(value)) {
        mergedRequired.push(...value);
      } else if (!(key in merged)) {
        merged[key] = value;
      }
    }

    if (Object.keys(mergedProperties).length > 0) {
      merged.properties = mergedProperties;
    }
    if (mergedRequired.length > 0) {
      merged.required = [...new Set(mergedRequired)];
    }
    if (!merged.type && merged.properties) {
      merged.type = 'object';
    }

    return merged;
  }

  // Recurse into oneOf / anyOf
  for (const keyword of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword] = schema[keyword].map(
        sub => flattenAllOf(sub, documentRoot, depth + 1, seenRefs)
      );
    }
  }

  // Recurse into properties
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      schema.properties[propName] = flattenAllOf(propSchema, documentRoot, depth + 1, seenRefs);
    }
  }

  // Recurse into items
  if (schema.items && typeof schema.items === 'object') {
    schema.items = flattenAllOf(schema.items, documentRoot, depth + 1, seenRefs);
  }

  return schema;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

/**
 * Walks every message in the AsyncAPI document and:
 * 1. Flattens allOf/oneOf/anyOf in the payload schema so the React component
 *    sees a simple merged schema (works around the React component's broken
 *    allOf example generation and type display).
 * 2. Generates a synthetic example payload by sampling the (now flat) schema
 *    for messages that lack explicit examples.
 *
 * Enabled via the `generateExamples` template parameter (default: false).
 */
module.exports = {
  'generate:before': ({ asyncapi, templateParams = {} }) => {
    const enabled =
      templateParams.generateExamples === true ||
      templateParams.generateExamples === 'true';

    if (!enabled) {
      return;
    }

    const documentRoot = asyncapi?._json;
    if (!documentRoot || typeof documentRoot !== 'object') {
      return;
    }

    const messages = documentRoot?.components?.messages;
    if (!messages || typeof messages !== 'object') {
      return;
    }

    for (const [messageName, message] of Object.entries(messages)) {
      if (!message || typeof message !== 'object') {
        continue;
      }

      if (!message.payload) {
        continue;
      }

      // Flatten allOf in the payload schema in-place so the React
      // component renders merged properties and correct types.
      message.payload = flattenAllOf(message.payload, documentRoot);

      // Skip example generation for messages that already have explicit examples
      if (Array.isArray(message.examples) && message.examples.length > 0) {
        continue;
      }

      const sample = sampleFromSchema(message.payload, documentRoot);
      if (sample !== null && sample !== undefined) {
        message.examples = [{ payload: sample }];
        // Also set schema-level example so the React component's
        // "Example" block picks it up directly.
        if (!Object.prototype.hasOwnProperty.call(message.payload, 'example')) {
          message.payload.example = sample;
        }
      }
    }
  },
};

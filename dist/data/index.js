'use strict';

var nanoid = require('nanoid');

// src/data/models.ts
var Agent = class _Agent {
  id;
  name;
  agentType;
  locale;
  prompt;
  expectedResult;
  tools;
  flows;
  events;
  settings;
  metadata;
  createdAt;
  updatedAt;
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.agentType = config.agentType;
    this.locale = config.locale || "en";
    this.prompt = config.prompt;
    this.expectedResult = config.expectedResult;
    this.tools = config.tools;
    this.flows = config.flows;
    this.events = config.events;
    this.settings = config.settings;
    this.metadata = config.metadata;
    this.createdAt = config.createdAt;
    this.updatedAt = config.updatedAt;
  }
  /**
   * Convert to AgentConfig for SDK usage
   */
  toConfig() {
    return {
      id: this.id,
      name: this.name,
      agentType: this.agentType,
      locale: this.locale,
      prompt: this.prompt,
      expectedResult: this.expectedResult,
      tools: this.tools,
      flows: this.flows,
      events: this.events,
      settings: this.settings,
      metadata: this.metadata
    };
  }
  /**
   * Create from AgentConfig
   */
  static fromConfig(config) {
    return new _Agent(config);
  }
};
var Session = class {
  id;
  agentId;
  data;
  messages;
  createdAt;
  updatedAt;
  constructor(data) {
    this.id = data.id;
    this.agentId = data.agentId;
    this.data = data.data;
    this.messages = data.messages;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    this.updatedAt = data.updatedAt || (/* @__PURE__ */ new Date()).toISOString();
  }
};
var Result = class {
  id;
  sessionId;
  agentId;
  result;
  success;
  error;
  tokensUsed;
  duration;
  createdAt;
  constructor(data) {
    this.id = data.id;
    this.sessionId = data.sessionId;
    this.agentId = data.agentId;
    this.result = data.result;
    this.success = data.success;
    this.error = data.error;
    this.tokensUsed = data.tokensUsed;
    this.duration = data.duration;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
  }
};
var Memory = class {
  id;
  agentId;
  sessionId;
  content;
  embedding;
  metadata;
  createdAt;
  constructor(data) {
    this.id = data.id;
    this.agentId = data.agentId;
    this.sessionId = data.sessionId;
    this.content = data.content;
    this.embedding = data.embedding;
    this.metadata = data.metadata;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
  }
  /**
   * Convenience getter for importance (from metadata)
   */
  get importance() {
    return this.metadata?.importance ?? 1;
  }
  /**
   * Convenience getter for access count (from metadata)
   */
  get accessCount() {
    return this.metadata?.accessCount ?? 0;
  }
  /**
   * Convenience getter for accessed at (from metadata)
   */
  get accessedAt() {
    return this.metadata?.accessedAt;
  }
};
var Attachment = class {
  id;
  displayName;
  description;
  mimeType;
  type;
  size;
  storageKey;
  filePath;
  content;
  metadata;
  createdAt;
  updatedAt;
  constructor(data) {
    this.id = data.id;
    this.displayName = data.displayName;
    this.description = data.description;
    this.mimeType = data.mimeType;
    this.type = data.type;
    this.size = data.size;
    this.storageKey = data.storageKey;
    this.filePath = data.filePath;
    this.content = data.content;
    this.metadata = data.metadata;
    this.createdAt = data.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    this.updatedAt = data.updatedAt || (/* @__PURE__ */ new Date()).toISOString();
  }
};
var BaseMockRepository = class {
  items = /* @__PURE__ */ new Map();
  async findById(id) {
    return this.items.get(id) || null;
  }
  async findMany(filter) {
    const items = Array.from(this.items.values());
    if (!filter) return items;
    return items.filter((item) => {
      return Object.entries(filter).every(([key, value]) => {
        return item[key] === value;
      });
    });
  }
  async create(data) {
    const id = this.generateId();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const item = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(id, item);
    return item;
  }
  async update(id, data) {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Item with id ${id} not found`);
    }
    const updated = {
      ...existing,
      ...data,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.items.set(id, updated);
    return updated;
  }
  async delete(id) {
    return this.items.delete(id);
  }
  async count(filter) {
    const items = await this.findMany(filter);
    return items.length;
  }
  clear() {
    this.items.clear();
  }
};
var MockAgentRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  async findByType(type) {
    return Array.from(this.items.values()).filter(
      (agent) => agent.agentType === type
    );
  }
  async findByName(name) {
    const items = Array.from(this.items.values());
    return items.find((agent) => agent.name === name) || null;
  }
  async search(query) {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.items.values()).filter(
      (agent) => agent.name.toLowerCase().includes(lowerQuery) || agent.prompt?.toLowerCase().includes(lowerQuery)
    );
  }
  async findWithPagination(options) {
    const { page = 1, perPage = 10 } = options;
    const items = Array.from(this.items.values());
    const total = items.length;
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const data = items.slice(start, end);
    return {
      data,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      hasMore: end < total
    };
  }
};
var MockSessionRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  async findByAgentId(agentId) {
    return Array.from(this.items.values()).filter(
      (session) => session.agentId === agentId
    );
  }
  async findWithMessages(sessionId) {
    return this.findById(sessionId);
  }
  async addMessage(sessionId, message) {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const messages = session.messages || [];
    return this.update(sessionId, {
      messages: [...messages, message]
    });
  }
  async updateData(sessionId, data) {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return this.update(sessionId, {
      data: { ...session.data, ...data }
    });
  }
};
var MockResultRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  async findBySessionId(sessionId) {
    const items = Array.from(this.items.values());
    return items.find((result) => result.sessionId === sessionId) || null;
  }
  async findByAgentId(agentId) {
    return Array.from(this.items.values()).filter(
      (result) => result.agentId === agentId
    );
  }
  async findSuccessful() {
    return Array.from(this.items.values()).filter((result) => result.success);
  }
  async findFailed() {
    return Array.from(this.items.values()).filter((result) => !result.success);
  }
};
var MockMemoryRepository = class extends BaseMockRepository {
  generateId() {
    return nanoid.nanoid();
  }
  /**
   * Override create to return Memory class instances
   */
  async create(data) {
    const id = this.generateId();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const memory = new Memory({
      ...data,
      id,
      createdAt: data.createdAt || now
    });
    this.items.set(id, memory);
    return memory;
  }
  /**
   * Override update to maintain Memory class instances
   */
  async update(id, data) {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Memory with id ${id} not found`);
    }
    const updated = new Memory({
      ...existing,
      ...data,
      id: existing.id,
      agentId: data.agentId || existing.agentId,
      content: data.content || existing.content,
      createdAt: existing.createdAt
    });
    this.items.set(id, updated);
    return updated;
  }
  async findByAgentId(agentId, limit) {
    const memories = Array.from(this.items.values()).filter(
      (memory) => memory.agentId === agentId
    );
    return limit ? memories.slice(0, limit) : memories;
  }
  async findBySessionId(sessionId) {
    return Array.from(this.items.values()).filter(
      (memory) => memory.sessionId === sessionId
    );
  }
  async search(agentId, query, limit = 10) {
    const lowerQuery = query.toLowerCase();
    const memories = Array.from(this.items.values()).filter(
      (memory) => memory.agentId === agentId && memory.content.toLowerCase().includes(lowerQuery)
    );
    return memories.slice(0, limit);
  }
  async searchByEmbedding(agentId, embedding, limit = 10) {
    const memories = Array.from(this.items.values()).filter((memory) => memory.agentId === agentId && memory.embedding).map((memory) => ({
      memory,
      similarity: this.cosineSimilarity(embedding, memory.embedding)
    })).sort((a, b) => b.similarity - a.similarity).slice(0, limit).map((item) => item.memory);
    return memories;
  }
  cosineSimilarity(a, b) {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magA * magB);
  }
};
var MockAttachmentRepository = class extends BaseMockRepository {
  nextId = 1;
  generateId() {
    return this.nextId++;
  }
  async findByStorageKey(storageKey) {
    const items = Array.from(this.items.values());
    return items.find((att) => att.storageKey === storageKey) || null;
  }
  async findByType(type) {
    return Array.from(this.items.values()).filter((att) => att.type === type);
  }
  async findWithContent(id) {
    return this.findById(id);
  }
};

exports.Agent = Agent;
exports.Attachment = Attachment;
exports.Memory = Memory;
exports.MockAgentRepository = MockAgentRepository;
exports.MockAttachmentRepository = MockAttachmentRepository;
exports.MockMemoryRepository = MockMemoryRepository;
exports.MockResultRepository = MockResultRepository;
exports.MockSessionRepository = MockSessionRepository;
exports.Result = Result;
exports.Session = Session;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map
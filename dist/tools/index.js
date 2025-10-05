'use strict';

var zod = require('zod');
var ai = require('ai');

// src/tools/ToolRegistry.ts
var ToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  /**
   * Register a tool
   */
  register(name, descriptor) {
    if (this.tools.has(name)) {
      console.warn(`Tool '${name}' is already registered. Overwriting.`);
    }
    this.tools.set(name, descriptor);
  }
  /**
   * Register multiple tools at once
   */
  registerMany(tools) {
    Object.entries(tools).forEach(([name, descriptor]) => {
      this.register(name, descriptor);
    });
  }
  /**
   * Get a tool by name
   */
  get(name) {
    return this.tools.get(name);
  }
  /**
   * Check if a tool exists
   */
  has(name) {
    return this.tools.has(name);
  }
  /**
   * Get all tool names
   */
  list() {
    return Array.from(this.tools.keys());
  }
  /**
   * Get all tools
   */
  getAll() {
    const result = {};
    this.tools.forEach((descriptor, name) => {
      result[name] = descriptor;
    });
    return result;
  }
  /**
   * Remove a tool
   */
  unregister(name) {
    return this.tools.delete(name);
  }
  /**
   * Clear all tools
   */
  clear() {
    this.tools.clear();
  }
  /**
   * Get the number of registered tools
   */
  size() {
    return this.tools.size;
  }
};
var globalToolRegistry = new ToolRegistry();
var currentDateTool = {
  displayName: "Get current date",
  tool: ai.tool({
    description: "Get the current date and time in ISO format (UTC timezone)",
    parameters: zod.z.object({}),
    execute: async () => {
      return (/* @__PURE__ */ new Date()).toISOString();
    }
  })
};
var dayNameTool = {
  displayName: "Get day name",
  tool: ai.tool({
    description: "Get the name of the day (e.g., Monday, Tuesday) for a given date",
    parameters: zod.z.object({
      date: zod.z.string().describe("The date to get the day name for in ISO format (e.g., 2024-01-15)"),
      locale: zod.z.string().optional().describe("The locale to use for the day name (e.g., en-US, pl-PL). Defaults to en-US")
    }),
    execute: async ({ date, locale = "en-US" }) => {
      return new Date(date).toLocaleDateString(locale, { weekday: "long" });
    }
  })
};
async function makeHttpRequest({
  url,
  method,
  headers,
  body,
  options = {}
}) {
  try {
    const fetchOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: body && method !== "GET" ? body : void 0
    };
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const data = await response.json();
      return JSON.stringify(data);
    } else {
      return await response.text();
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`HTTP request failed: ${error.message}`);
    }
    throw new Error("HTTP request failed with unknown error");
  }
}
function createHttpTool(options = {}) {
  return {
    displayName: "Make HTTP request",
    tool: ai.tool({
      description: "Makes HTTP requests to specified URLs with configurable method, headers, and body. Supports GET, POST, PUT, DELETE, and PATCH methods.",
      parameters: zod.z.object({
        url: zod.z.string().describe("The URL to make the request to (must be a valid HTTP/HTTPS URL)"),
        method: zod.z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("The HTTP method to use"),
        headers: zod.z.record(zod.z.string()).optional().describe("Optional headers to include in the request as key-value pairs"),
        body: zod.z.string().optional().describe("The body of the request. For POST/PUT/PATCH, this should be a JSON string. Not used for GET/DELETE.")
      }),
      execute: async ({ url, method, headers, body }) => {
        return makeHttpRequest({ url, method, headers, body, options });
      }
    })
  };
}
var httpTool = createHttpTool();
async function sendEmail({
  from,
  to,
  subject,
  text,
  html,
  apiKey,
  apiUrl = "https://api.resend.com/emails"
}) {
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text,
        html
      })
    });
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Email sending failed (${response.status}): ${errorData}`);
    }
    const data = await response.json();
    return JSON.stringify(data);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
    throw new Error("Failed to send email with unknown error");
  }
}
function createEmailTool(options) {
  const { apiKey, apiUrl, defaultFrom } = options;
  if (!apiKey) {
    throw new Error("Email tool requires an apiKey in options");
  }
  return {
    displayName: "Send email",
    tool: ai.tool({
      description: "Sends an email using the Resend.com API. Provide sender, recipients, subject, and content.",
      parameters: zod.z.object({
        from: zod.z.string().describe('The sender email address (e.g., "Sender Name <sender@example.com>"). Can use default if configured.').optional(),
        to: zod.z.array(zod.z.string()).describe('Array of recipient email addresses (e.g., ["user@example.com"])'),
        subject: zod.z.string().describe("The subject line of the email"),
        text: zod.z.string().describe("Plain text content of the email"),
        html: zod.z.string().describe("HTML content of the email")
      }),
      execute: async ({ from, to, subject, text, html }) => {
        const senderEmail = from || defaultFrom;
        if (!senderEmail) {
          throw new Error('Email "from" address is required. Provide it in the parameters or set defaultFrom in options.');
        }
        return sendEmail({
          from: senderEmail,
          to,
          subject,
          text,
          html,
          apiKey,
          apiUrl
        });
      }
    })
  };
}

exports.ToolRegistry = ToolRegistry;
exports.createEmailTool = createEmailTool;
exports.createHttpTool = createHttpTool;
exports.currentDateTool = currentDateTool;
exports.dayNameTool = dayNameTool;
exports.globalToolRegistry = globalToolRegistry;
exports.httpTool = httpTool;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map
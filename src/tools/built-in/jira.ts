/**
 * Jira Integration Tools
 * 
 * Provides a comprehensive set of tools for interacting with Jira API.
 * These tools can be used directly in agents without reimplementation.
 * 
 * @example
 * ```typescript
 * const jiraTools = new JiraTools({
 *   baseUrl: process.env.JIRA_BASE_URL,
 *   email: process.env.JIRA_EMAIL,
 *   apiToken: process.env.JIRA_API_TOKEN
 * });
 * 
 * const agent = new AgentBuilder()
 *   .withTools(jiraTools)
 *   .build();
 * ```
 */

import { z } from 'zod';
import { ToolRegistry } from '../ToolRegistry';
import { defineTool, type DefinedTool } from '../defineTool';
import { ToolDescriptor } from '../../types';
import { routeFetchThroughSandbox } from './sandboxFetch';
import { assertOk } from './assertOk';
import { toolFailure } from './toolFailure';

// ============================================================================
// Type Definitions
// ============================================================================

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraTicket {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  status: string;
  assignee: string;
  reporter: string;
  project: string;
  components: string[];
  labels: string[];
  created: string;
  updated: string;
  customFields?: Record<string, unknown>;
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
  updated: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
  };
}

// The Jira REST API resources read below (only the fields used).

/** An Atlassian Document Format node. */
interface AdfNode {
  type?: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
}

interface JiraUser {
  displayName: string;
}

interface JiraIssueResource {
  key: string;
  fields: {
    summary: string;
    description?: AdfNode | string | null;
    issuetype: { name: string };
    priority?: { name?: string } | null;
    status: { name: string };
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    project: { key: string };
    components?: Array<{ name: string }>;
    labels?: string[];
    created: string;
    updated: string;
    [field: string]: unknown;
  };
}

interface JiraCommentResource {
  id: string;
  author: JiraUser;
  body?: AdfNode | string | null;
  created: string;
  updated: string;
}

interface JiraIssueTypeResource {
  id: string;
  name: string;
  description?: string;
  subtask?: boolean;
}

interface JiraProjectResource {
  key: string;
  name: string;
  projectTypeKey?: string;
  lead?: JiraUser;
}

interface JiraWorklogResource {
  id: string;
  author: JiraUser;
  timeSpent: string;
  started: string;
  comment?: AdfNode | string | null;
}

/** A Jira user's display name, or `fallback` when there is no such user. */
function displayNameOr(user: { displayName?: string } | null | undefined, fallback: string): string {
  return user?.displayName || fallback;
}

// ============================================================================
// Jira Tools Registry
// ============================================================================

export class JiraTools extends ToolRegistry {
  private config: JiraConfig;
  private authHeader: string;

  constructor(config: JiraConfig) {
    super();
    this.config = config;
    this.authHeader = `Basic ${Buffer.from(
      `${config.email}:${config.apiToken}`
    ).toString('base64')}`;
    this.registerAllTools();
  }

  /**
   * LOU-K2: every Jira tool's execute() makes a real outbound HTTP call to
   * the configured Jira instance via the ambient global `fetch`. Flag it
   * requiresSandbox and route sandboxExecute() through withSandboxedFetch(),
   * which swaps `fetch` for a SandboxAdapter-routed implementation just for
   * the duration of the original execute() call - so a caller going through
   * executeToolWithSandboxGuard() (AgentExecutor, resume.ts) gets the fetch
   * call genuinely routed through the configured SandboxAdapter, without
   * every one of this file's register*() methods needing its own
   * hand-written sandboxed reimplementation. execute() itself is left
   * completely unchanged - still a real, directly-callable implementation -
   * for callers that invoke descriptor.tool.execute() directly rather than
   * through the guard.
   */
  public register(tool: DefinedTool): void;
  public register(name: string, descriptor: ToolDescriptor): void;
  public register(...args: [DefinedTool] | [string, ToolDescriptor]): void {
    routeFetchThroughSandbox(args.length === 1 ? args[0] : args[1]);
    if (args.length === 1) {
      super.register(args[0]);
      return;
    }
    super.register(args[0], args[1]);
  }

  private registerAllTools() {
    this.registerGetTicket();
    this.registerSearchTickets();
    this.registerCreateTicket();
    this.registerUpdateTicket();
    this.registerDeleteTicket();
    this.registerCreateSubtask();
    this.registerLinkIssues();
    this.registerAddComment();
    this.registerGetComments();
    this.registerUpdateComment();
    this.registerDeleteComment();
    this.registerTransitionIssue();
    this.registerGetTransitions();
    this.registerAssignIssue();
    this.registerAddWatcher();
    this.registerGetIssueTypes();
    this.registerGetProjects();
    this.registerAddAttachment();
    this.registerAddWorklog();
    this.registerGetWorklogs();
  }

  // ========================================================================
  // Core Issue Operations
  // ========================================================================

  private registerGetTicket() {
    this.register(
      defineTool({
        name: 'jira_get_ticket',
        displayName: 'Get Jira Ticket',
        description: 'Get detailed information about a Jira ticket including all fields, comments, and metadata',
        input: z.object({
          ticketKey: z.string().describe('The Jira ticket key (e.g., PROJ-123)'),
          expand: z.array(z.enum(['renderedFields', 'names', 'schema', 'transitions', 'operations', 'editmeta', 'changelog', 'versionedRepresentations']))
            .optional()
            .describe('Additional data to include in response'),
        }),
        execute: async ({ ticketKey, expand }) => {
          const params = new URLSearchParams();
          if (expand && expand.length > 0) {
            params.append('expand', expand.join(','));
          }

          const url = `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}${params.toString() ? `?${params}` : ''}`;
          
          const response = await fetch(url, {
            headers: this.jsonHeaders(),
          });

          await assertOk(response, 'Failed to fetch Jira ticket');

          const data = await response.json();
          const ticket = this.toJiraTicket(data);

          return JSON.stringify(ticket, null, 2);
        },
      })
    );
  }

  private registerSearchTickets() {
    this.register(
      defineTool({
        name: 'jira_search_tickets',
        displayName: 'Search Jira Tickets',
        description: 'Search for Jira tickets using JQL (Jira Query Language). Returns matching tickets.',
        input: z.object({
          jql: z.string().describe('JQL query string (e.g., "project = PROJ AND status = Open")'),
          maxResults: z.number().optional().default(50).describe('Maximum number of results to return'),
          startAt: z.number().optional().default(0).describe('Starting index for pagination'),
          fields: z.array(z.string()).optional().describe('Specific fields to return'),
        }),
        execute: async ({ jql, maxResults = 50, startAt = 0, fields }) => {
          const body: Record<string, unknown> = {
            jql,
            maxResults,
            startAt,
          };

          if (fields && fields.length > 0) {
            body.fields = fields;
          }

          const response = await this.sendJson('/rest/api/3/search', body);

          await assertOk(response, 'Failed to search tickets');

          const data = await response.json();
          
          const tickets = data.issues.map((issue: JiraIssueResource) => ({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
            assignee: displayNameOr(issue.fields.assignee, 'Unassigned'),
            priority: issue.fields.priority?.name || 'None',
            updated: issue.fields.updated,
          }));

          return JSON.stringify({
            total: data.total,
            startAt: data.startAt,
            maxResults: data.maxResults,
            issues: tickets,
          }, null, 2);
        },
      })
    );
  }

  private registerCreateTicket() {
    this.register(
      defineTool({
        name: 'jira_create_ticket',
        displayName: 'Create Jira Ticket',
        description: 'Create a new Jira ticket/issue',
        input: z.object({
          projectKey: z.string().describe('Project key (e.g., PROJ)'),
          issueType: z.string().describe('Issue type (e.g., Task, Bug, Story)'),
          summary: z.string().describe('Issue summary/title'),
          description: z.string().describe('Detailed description'),
          priority: z.string().optional().describe('Priority (e.g., High, Medium, Low)'),
          assignee: z.string().optional().describe('Assignee account ID or email'),
          labels: z.array(z.string()).optional().describe('Labels to add'),
          components: z.array(z.string()).optional().describe('Component names'),
        }),
        execute: async ({ projectKey, issueType, summary, description, priority, assignee, labels, components }) => {
          const fields: Record<string, unknown> = {
            project: { key: projectKey },
            issuetype: { name: issueType },
            summary,
            description: this.createADF(description),
          };

          if (priority) {
            fields.priority = { name: priority };
          }

          if (assignee) {
            fields.assignee = { accountId: assignee };
          }

          if (labels && labels.length > 0) {
            fields.labels = labels;
          }

          if (components && components.length > 0) {
            fields.components = components.map(name => ({ name }));
          }

          const response = await this.sendJson('/rest/api/3/issue', { fields });

          await assertOk(response, 'Failed to create ticket');

          const data = await response.json();
          return JSON.stringify({
            key: data.key,
            id: data.id,
            self: data.self,
          }, null, 2);
        },
      })
    );
  }

  private registerUpdateTicket() {
    this.register(
      defineTool({
        name: 'jira_update_ticket',
        displayName: 'Update Jira Ticket',
        description: 'Update fields of an existing Jira ticket',
        input: z.object({
          ticketKey: z.string().describe('Ticket key to update'),
          summary: z.string().optional().describe('New summary'),
          description: z.string().optional().describe('New description'),
          priority: z.string().optional().describe('New priority'),
          labels: z.array(z.string()).optional().describe('Labels to set'),
        }),
        execute: async ({ ticketKey, summary, description, priority, labels }) => {
          const fields: Record<string, unknown> = {};

          if (summary) fields.summary = summary;
          if (description) fields.description = this.createADF(description);
          if (priority) fields.priority = { name: priority };
          if (labels) fields.labels = labels;

          if (Object.keys(fields).length === 0) {
            throw toolFailure('At least one field must be provided to update');
          }

          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify({ fields }),
            }
          );

          await assertOk(response, 'Failed to update ticket');

          return JSON.stringify({ success: true, ticketKey }, null, 2);
        },
      })
    );
  }

  private registerDeleteTicket() {
    this.register(
      defineTool({
        name: 'jira_delete_ticket',
        displayName: 'Delete Jira Ticket',
        description: 'Delete a Jira ticket permanently',
        input: z.object({
          ticketKey: z.string().describe('Ticket key to delete'),
        }),
        execute: async ({ ticketKey }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
              },
            }
          );

          await assertOk(response, 'Failed to delete ticket');

          return JSON.stringify({ success: true, ticketKey, message: 'Ticket deleted successfully' });
        },
      })
    );
  }

  private registerCreateSubtask() {
    this.register(
      defineTool({
        name: 'jira_create_subtask',
        displayName: 'Create Jira Subtask',
        description: 'Create a subtask under a parent Jira ticket',
        input: z.object({
          parentKey: z.string().describe('Parent ticket key'),
          summary: z.string().describe('Subtask summary'),
          description: z.string().describe('Detailed description'),
          assignee: z.string().optional().describe('Assignee account ID'),
        }),
        execute: async ({ parentKey, summary, description, assignee }) => {
          // First, get the project from parent
          const projectKey = parentKey.split('-')[0];

          const fields: Record<string, unknown> = {
            project: { key: projectKey },
            parent: { key: parentKey },
            summary,
            description: this.createADF(description),
            issuetype: { name: 'Sub-task' }, // Try "Sub-task" first
          };

          if (assignee) {
            fields.assignee = { accountId: assignee };
          }

          let response = await this.sendJson('/rest/api/3/issue', { fields });

          // If "Sub-task" fails, try "Subtask"
          if (!response.ok) {
            const errorText = await response.text();
            if (errorText.includes('issuetype')) {
              fields.issuetype = { name: 'Subtask' };
              response = await this.sendJson('/rest/api/3/issue', { fields });
            }
          }

          await assertOk(response, 'Failed to create subtask');

          const data = await response.json();
          return JSON.stringify({ key: data.key, id: data.id }, null, 2);
        },
      })
    );
  }

  private registerLinkIssues() {
    this.register(
      defineTool({
        name: 'jira_link_issues',
        displayName: 'Link Jira Issues',
        description: 'Create a link between two Jira issues',
        input: z.object({
          inwardIssue: z.string().describe('Inward issue key'),
          outwardIssue: z.string().describe('Outward issue key'),
          linkType: z.string().describe('Link type (e.g., "Blocks", "Relates to", "Duplicates")'),
          comment: z.string().optional().describe('Optional comment for the link'),
        }),
        execute: async ({ inwardIssue, outwardIssue, linkType, comment }) => {
          const body: Record<string, unknown> = {
            type: { name: linkType },
            inwardIssue: { key: inwardIssue },
            outwardIssue: { key: outwardIssue },
          };

          if (comment) {
            body.comment = { body: this.createADF(comment) };
          }

          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issueLink`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          await assertOk(response, 'Failed to link issues');

          return JSON.stringify({
            success: true,
            inwardIssue,
            outwardIssue,
            linkType,
          });
        },
      })
    );
  }

  // ========================================================================
  // Comment Operations
  // ========================================================================

  private registerAddComment() {
    this.register(
      defineTool({
        name: 'jira_add_comment',
        displayName: 'Add Jira Comment',
        description: 'Add a comment to a Jira ticket',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          comment: z.string().describe('Comment text'),
        }),
        execute: async ({ ticketKey, comment }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/comment`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify({
                body: this.createADF(comment),
              }),
            }
          );

          await assertOk(response, 'Failed to add comment');

          const data = await response.json();
          return JSON.stringify({
            id: data.id,
            created: data.created,
            author: data.author.displayName,
          });
        },
      })
    );
  }

  private registerGetComments() {
    this.register(
      defineTool({
        name: 'jira_get_comments',
        displayName: 'Get Jira Comments',
        description: 'Get all comments for a Jira ticket',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          maxResults: z.number().optional().default(50).describe('Maximum number of comments to return'),
          startAt: z.number().optional().default(0).describe('Starting index for pagination'),
        }),
        execute: async ({ ticketKey, maxResults = 50, startAt = 0 }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/comment?maxResults=${maxResults}&startAt=${startAt}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
              },
            }
          );

          await assertOk(response, 'Failed to get comments');

          const data = await response.json();
          
          const comments: JiraComment[] = data.comments.map((comment: JiraCommentResource) => ({
            id: comment.id,
            author: comment.author.displayName,
            body: this.extractTextFromADF(comment.body),
            created: comment.created,
            updated: comment.updated,
          }));

          return JSON.stringify({
            total: data.total,
            maxResults: data.maxResults,
            startAt: data.startAt,
            comments,
          }, null, 2);
        },
      })
    );
  }

  private registerUpdateComment() {
    this.register(
      defineTool({
        name: 'jira_update_comment',
        displayName: 'Update Jira Comment',
        description: 'Update an existing comment on a Jira ticket',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          commentId: z.string().describe('Comment ID to update'),
          newComment: z.string().describe('New comment text'),
        }),
        execute: async ({ ticketKey, commentId, newComment }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/comment/${commentId}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify({
                body: this.createADF(newComment),
              }),
            }
          );

          await assertOk(response, 'Failed to update comment');

          const data = await response.json();
          return JSON.stringify({
            id: data.id,
            updated: data.updated,
          });
        },
      })
    );
  }

  private registerDeleteComment() {
    this.register(
      defineTool({
        name: 'jira_delete_comment',
        displayName: 'Delete Jira Comment',
        description: 'Delete a comment from a Jira ticket',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          commentId: z.string().describe('Comment ID to delete'),
        }),
        execute: async ({ ticketKey, commentId }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/comment/${commentId}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
              },
            }
          );

          await assertOk(response, 'Failed to delete comment');

          return JSON.stringify({ success: true, commentId });
        },
      })
    );
  }

  // ========================================================================
  // Transition & Workflow Operations
  // ========================================================================

  private registerTransitionIssue() {
    this.register(
      defineTool({
        name: 'jira_transition_issue',
        displayName: 'Transition Jira Issue',
        description: 'Transition a Jira issue to a different status (e.g., In Progress, Done)',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          transitionId: z.string().describe('Transition ID (get from jira_get_transitions)'),
          comment: z.string().optional().describe('Optional comment for the transition'),
        }),
        execute: async ({ ticketKey, transitionId, comment }) => {
          const body: Record<string, unknown> = {
            transition: { id: transitionId },
          };

          if (comment) {
            body.update = {
              comment: [{
                add: { body: this.createADF(comment) }
              }]
            };
          }

          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/transitions`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          await assertOk(response, 'Failed to transition issue');

          return JSON.stringify({ success: true, ticketKey, transitionId });
        },
      })
    );
  }

  private registerGetTransitions() {
    this.register(
      defineTool({
        name: 'jira_get_transitions',
        displayName: 'Get Jira Transitions',
        description: 'Get available transitions for a Jira issue (what statuses it can move to)',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
        }),
        execute: async ({ ticketKey }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/transitions`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
              },
            }
          );

          await assertOk(response, 'Failed to get transitions');

          const data = await response.json();
          
          const transitions: JiraTransition[] = data.transitions.map((t: JiraTransition) => ({
            id: t.id,
            name: t.name,
            to: {
              id: t.to.id,
              name: t.to.name,
            },
          }));

          return JSON.stringify({ transitions }, null, 2);
        },
      })
    );
  }

  // ========================================================================
  // Assignment & Watchers
  // ========================================================================

  private registerAssignIssue() {
    this.register(
      defineTool({
        name: 'jira_assign_issue',
        displayName: 'Assign Jira Issue',
        description: 'Assign a Jira issue to a user',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          accountId: z.string().describe('User account ID (use null or "-1" to unassign)'),
        }),
        execute: async ({ ticketKey, accountId }) => {
          const body = accountId === 'null' || accountId === '-1' 
            ? { accountId: null }
            : { accountId };

          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/assignee`,
            {
              method: 'PUT',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          await assertOk(response, 'Failed to assign issue');

          return JSON.stringify({ success: true, ticketKey, assignee: accountId });
        },
      })
    );
  }

  private registerAddWatcher() {
    this.register(
      defineTool({
        name: 'jira_add_watcher',
        displayName: 'Add Jira Watcher',
        description: 'Add a watcher to a Jira issue',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          accountId: z.string().describe('User account ID to add as watcher'),
        }),
        execute: async ({ ticketKey, accountId }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/watchers`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(accountId),
            }
          );

          await assertOk(response, 'Failed to add watcher');

          return JSON.stringify({ success: true, ticketKey, watcher: accountId });
        },
      })
    );
  }

  // ========================================================================
  // Metadata & Configuration
  // ========================================================================

  private registerGetIssueTypes() {
    this.register(
      defineTool({
        name: 'jira_get_issue_types',
        displayName: 'Get Jira Issue Types',
        description: 'Get all available issue types in Jira (e.g., Task, Bug, Story, Sub-task)',
        input: z.object({
          projectKey: z.string().optional().describe('Optional project key to filter issue types'),
        }),
        execute: async ({ projectKey }) => {
          let url = `${this.config.baseUrl}/rest/api/3/issuetype`;
          
          if (projectKey) {
            url = `${this.config.baseUrl}/rest/api/3/issuetype/project?projectId=${projectKey}`;
          }

          const response = await fetch(url, {
            headers: {
              'Authorization': this.authHeader,
              'Accept': 'application/json',
            },
          });

          await assertOk(response, 'Failed to get issue types');

          const data = await response.json();
          const issueTypes = Array.isArray(data) ? data : [data];
          
          const types = issueTypes.map((type: JiraIssueTypeResource) => ({
            id: type.id,
            name: type.name,
            description: type.description,
            subtask: type.subtask,
          }));

          return JSON.stringify({ issueTypes: types }, null, 2);
        },
      })
    );
  }

  private registerGetProjects() {
    this.register(
      defineTool({
        name: 'jira_get_projects',
        displayName: 'Get Jira Projects',
        description: 'Get all accessible Jira projects',
        input: z.object({
          maxResults: z.number().optional().default(50).describe('Maximum number of projects to return'),
        }),
        execute: async ({ maxResults = 50 }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/project?maxResults=${maxResults}`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
              },
            }
          );

          await assertOk(response, 'Failed to get projects');

          const data = await response.json();
          
          const projects = data.map((project: JiraProjectResource) => ({
            key: project.key,
            name: project.name,
            projectTypeKey: project.projectTypeKey,
            lead: project.lead?.displayName,
          }));

          return JSON.stringify({ projects }, null, 2);
        },
      })
    );
  }

  // ========================================================================
  // Attachments & Worklogs
  // ========================================================================

  private registerAddAttachment() {
    this.register(
      defineTool({
        name: 'jira_add_attachment',
        displayName: 'Add Jira Attachment',
        description: 'Add an attachment to a Jira issue',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          fileName: z.string().describe('Name of the file'),
          fileContent: z.string().describe('Base64 encoded file content'),
        }),
        execute: async ({ ticketKey, fileName, fileContent }) => {
          // Convert base64 to buffer
          const buffer = Buffer.from(fileContent, 'base64');
          
          const formData = new FormData();
          formData.append('file', new Blob([buffer]), fileName);

          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/attachments`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'X-Atlassian-Token': 'no-check',
              },
              body: formData,
            }
          );

          await assertOk(response, 'Failed to add attachment');

          const data = await response.json();
          return JSON.stringify({
            id: data[0].id,
            filename: data[0].filename,
            size: data[0].size,
          });
        },
      })
    );
  }

  private registerAddWorklog() {
    this.register(
      defineTool({
        name: 'jira_add_worklog',
        displayName: 'Add Jira Worklog',
        description: 'Log time spent on a Jira issue',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
          timeSpent: z.string().describe('Time spent (e.g., "3h 30m", "1d", "2w")'),
          comment: z.string().optional().describe('Optional worklog comment'),
          started: z.string().optional().describe('When the work started (ISO 8601 format)'),
        }),
        execute: async ({ ticketKey, timeSpent, comment, started }) => {
          const body: Record<string, unknown> = {
            timeSpent,
          };

          if (comment) {
            body.comment = this.createADF(comment);
          }

          if (started) {
            body.started = started;
          }

          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/worklog`,
            {
              method: 'POST',
              headers: {
                'Authorization': this.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(body),
            }
          );

          await assertOk(response, 'Failed to add worklog');

          const data = await response.json();
          return JSON.stringify({
            id: data.id,
            timeSpent: data.timeSpent,
            started: data.started,
          });
        },
      })
    );
  }

  private registerGetWorklogs() {
    this.register(
      defineTool({
        name: 'jira_get_worklogs',
        displayName: 'Get Jira Worklogs',
        description: 'Get all worklogs for a Jira issue',
        input: z.object({
          ticketKey: z.string().describe('Ticket key'),
        }),
        execute: async ({ ticketKey }) => {
          const response = await fetch(
            `${this.config.baseUrl}/rest/api/3/issue/${ticketKey}/worklog`,
            {
              headers: {
                'Authorization': this.authHeader,
                'Accept': 'application/json',
              },
            }
          );

          await assertOk(response, 'Failed to get worklogs');

          const data = await response.json();
          
          const worklogs = data.worklogs.map((log: JiraWorklogResource) => ({
            id: log.id,
            author: log.author.displayName,
            timeSpent: log.timeSpent,
            started: log.started,
            comment: this.extractTextFromADF(log.comment),
          }));

          return JSON.stringify({ worklogs }, null, 2);
        },
      })
    );
  }

  // ========================================================================
  // Helper Methods
  // ========================================================================

  /**
   * Headers for a JSON request/response against the Jira REST API
   */
  private jsonHeaders(): Record<string, string> {
    return {
      'Authorization': this.authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  /**
   * Send `payload` as JSON to a Jira REST API path (POST by default)
   */
  private sendJson(path: string, payload: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<Response> {
    return fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload),
    });
  }

  /**
   * Map a Jira issue resource to a JiraTicket
   */
  private toJiraTicket(data: JiraIssueResource): JiraTicket {
    return {
      key: data.key,
      summary: data.fields.summary,
      description: this.extractTextFromADF(data.fields.description),
      issueType: data.fields.issuetype.name,
      priority: data.fields.priority?.name || 'None',
      status: data.fields.status.name,
      assignee: displayNameOr(data.fields.assignee, 'Unassigned'),
      reporter: displayNameOr(data.fields.reporter, 'Unknown'),
      project: data.fields.project.key,
      components: data.fields.components?.map((c) => c.name) || [],
      labels: data.fields.labels || [],
      created: data.fields.created,
      updated: data.fields.updated,
      customFields: this.extractCustomFields(data.fields),
    };
  }

  /**
   * Convert text to Atlassian Document Format (ADF)
   */
  private createADF(text: string): AdfNode {
    return {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text,
            },
          ],
        },
      ],
    };
  }

  /**
   * Extract plain text from Atlassian Document Format (ADF)
   */
  private extractTextFromADF(adf: AdfNode | string | null | undefined): string {
    if (!adf) return '';
    if (typeof adf === 'string') return adf;
    
    let text = '';
    
    const extractContent = (node: AdfNode): void => {
      if (node.type === 'text') {
        text += node.text;
      } else if (node.content) {
        for (const child of node.content) {
          extractContent(child);
        }
      }
    };
    
    extractContent(adf);
    return text.trim();
  }

  /**
   * Extract custom fields from Jira fields object
   */
  private extractCustomFields(fields: Record<string, unknown>): Record<string, unknown> {
    const customFields: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(fields)) {
      if (key.startsWith('customfield_')) {
        customFields[key] = value;
      }
    }
    
    return customFields;
  }
}

// Export convenience function to create Jira tools
export function createJiraTools(config: JiraConfig): JiraTools {
  return new JiraTools(config);
}

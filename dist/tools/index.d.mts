export { T as ToolRegistry, g as globalToolRegistry } from '../ToolRegistry-lDQ_JocJ.mjs';
import { T as ToolDescriptor } from '../tool-DW-oM1Ru.mjs';
import 'ai';

/**
 * Current Date Tool
 * Returns the current date in ISO format
 */
declare const currentDateTool: ToolDescriptor;

/**
 * Day Name Tool
 * Returns the name of the day for a given date
 */
declare const dayNameTool: ToolDescriptor;

/**
 * HTTP Tool Configuration Options
 */
interface HttpToolOptions {
    /**
     * Maximum timeout for HTTP requests in milliseconds
     * @default 30000 (30 seconds)
     */
    timeout?: number;
    /**
     * Maximum number of redirects to follow
     * @default 5
     */
    maxRedirects?: number;
    /**
     * Whether to validate SSL certificates
     * @default true
     */
    validateSSL?: boolean;
}
/**
 * Create HTTP Tool
 * Factory function to create an HTTP tool with custom options
 */
declare function createHttpTool(options?: HttpToolOptions): ToolDescriptor;
/**
 * Default HTTP Tool instance
 */
declare const httpTool: ToolDescriptor;

/**
 * Email Tool Configuration Options
 */
interface EmailToolOptions {
    /**
     * Email service provider API key
     * Required for sending emails
     */
    apiKey: string;
    /**
     * Email service provider API URL
     * @default 'https://api.resend.com/emails'
     */
    apiUrl?: string;
    /**
     * Default "from" email address
     * Can be overridden per email
     */
    defaultFrom?: string;
}
/**
 * Create Email Tool
 * Factory function to create an email tool with custom configuration
 */
declare function createEmailTool(options: EmailToolOptions): ToolDescriptor;

export { type EmailToolOptions, type HttpToolOptions, createEmailTool, createHttpTool, currentDateTool, dayNameTool, httpTool };

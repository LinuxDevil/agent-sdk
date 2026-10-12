// streaming.md:34
interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly runId: string;                   // the runId on every event
  readonly result: Promise<ExecutionResult>; // what send() / execute() would return
  enqueue(input: AgentInput): EnqueueResult; // add user input to the running run
  steer(input: AgentInput): SteerResult;     // redirect the running run to new input
}
export {};

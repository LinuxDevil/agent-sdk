// streaming.md:341
const source = new EventSource('/chat?q=Weather%20in%20Paris%3F');
source.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (event.type === 'text.delta') output.textContent += event.text;
  if (event.type === 'run.done') source.close();
};
export {};

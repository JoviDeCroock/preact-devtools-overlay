import { render } from "preact";
import { useState } from "preact/hooks";
import { signal, computed, useSignal } from "@preact/signals";

const todos = signal([
	{ id: 1, text: "Inspect a component", done: false },
	{ id: 2, text: "Watch a signal update", done: true },
]);
const remaining = computed(() => todos.value.filter(t => !t.done).length);

function Counter() {
	const [count, setCount] = useState(0);
	return (
		<button data-testid="counter" onClick={() => setCount(c => c + 1)}>
			Hook count: {count}
		</button>
	);
}

function SignalCounter() {
	const count = useSignal(0);
	return (
		<button data-testid="signal-counter" onClick={() => count.value++}>
			Signal count: {count}
		</button>
	);
}

function TodoItem({ todo }: { todo: { id: number; text: string; done: boolean } }) {
	return (
		<li>
			<label>
				<input
					type="checkbox"
					checked={todo.done}
					onChange={() => {
						todos.value = todos.value.map(t =>
							t.id === todo.id ? { ...t, done: !t.done } : t,
						);
					}}
				/>
				{todo.text}
			</label>
		</li>
	);
}

// `?rows=200` renders extra components, e.g. to exercise the virtualized tree.
const extraRows = Number(new URLSearchParams(location.search).get("rows")) || 0;

function Row({ index }: { index: number }) {
	return <li>Row {index}</li>;
}

function App() {
	return (
		<main style="font-family: system-ui; padding: 1rem 2rem">
			<h1>preact-devtools-overlay</h1>
			<p>
				Open the overlay with the button in the corner or{" "}
				<kbd>Alt+Shift+D</kbd>.
			</p>
			<Counter />
			<SignalCounter />
			<h2>Todos ({remaining} remaining)</h2>
			<ul>
				{todos.value.map(t => (
					<TodoItem key={t.id} todo={t} />
				))}
			</ul>
			{extraRows > 0 && (
				<ol>
					{Array.from({ length: extraRows }, (_, i) => (
						<Row key={i} index={i} />
					))}
				</ol>
			)}
		</main>
	);
}

render(<App />, document.getElementById("app")!);

import { greeting } from "../domain/greeting.ts";

export function App() {
  return <h1>{greeting("world")}</h1>;
}

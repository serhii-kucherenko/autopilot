import { redirect } from "next/navigation";

/** The digest is what a person opens the console for. Start there. */
export default function Home() {
  redirect("/digest");
}

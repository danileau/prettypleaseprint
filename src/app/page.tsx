import { redirect } from "next/navigation";

/** Home is the board for everyone; the admin queue is the next slice. */
export default function Index() {
  redirect("/board");
}

import { GeneralBoardPageView } from "../../components/GeneralBoardPageView";
import { getView } from "../data";

// 1時間ごとに作り直す（ISR）。見る人のたびにデータベースを読まない
export const revalidate = 3600;

export default async function GeneralBoardPage() {
  return <GeneralBoardPageView view={await getView()} />;
}

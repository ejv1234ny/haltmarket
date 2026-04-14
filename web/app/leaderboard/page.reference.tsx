import { createClient } from '@/lib/supabase-server';
import LeaderboardClient from './LeaderboardClient';

export default async function LeaderboardPage() {
  const supabase = await createClient();

  // Pre-fetch default leaderboard data (humans, sorted by accuracy, min 5 predictions)
  const { data } = await supabase
    .from('prediction_leaderboard')
    .select('*')
    .or('account_type.is.null,account_type.eq.human')
    .gt('total_predictions', 5)
    .order('direction_accuracy', { ascending: false, nullsFirst: false })
    .limit(100);

  const leaders = data ?? [];
  const totalPredictions = leaders.reduce((sum, d) => sum + d.total_predictions, 0);

  return (
    <LeaderboardClient
      initialLeaders={leaders}
      initialTotalPredictions={totalPredictions}
    />
  );
}

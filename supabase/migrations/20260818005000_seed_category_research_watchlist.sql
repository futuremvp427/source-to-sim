-- Seed the cross-category RESEARCH watchlist only.
--
-- This migration creates NO paper_experiments, NO ingestion workers, NO live
-- configuration and NO Master Portfolio membership. These wallets are metadata
-- inputs to the existing bounded candidate_* public-research system only.
--
-- Eleven unique wallets represent twelve category slots because LlamaLoco0000
-- is deliberately researched in both CRYPTO and WORLD_POLITICS. The source
-- field records the intended research sleeve without changing the existing
-- candidate_watchlist schema.
--
-- ON CONFLICT DO NOTHING preserves any existing candidate status, notes,
-- metrics linkage or manually curated metadata. Replays are idempotent.

INSERT INTO public.candidate_watchlist (
  handle,
  wallet,
  wallet_resolved,
  source,
  status,
  notes,
  weekly_snapshot_rank,
  weekly_snapshot_pnl
)
VALUES
  -- WEATHER
  ('WeatherHK2', '0xdadbf9e1df1b8d7a184a0d6ab9c83b2337b61870', true, 'CATEGORY_RESEARCH:WEATHER', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),
  ('gopfan2', '0xf2f6af4f27ec2dcf4072095ab804016e14cd5817', true, 'CATEGORY_RESEARCH:WEATHER', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),
  ('automatedAItradingbot', '0xd8f8c13644ea84d62e1ec88c5d1215e436eb0f11', true, 'CATEGORY_RESEARCH:WEATHER', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),

  -- CRYPTO
  ('BadTattoo', '0xa7011667f22c121c6cea7aab30192307c58c47cd', true, 'CATEGORY_RESEARCH:CRYPTO', 'RESEARCH', 'Research-only category candidate; existing paper candidate, if present, is untouched.', null, null),
  ('jjda', '0x918cf17729b6f53862d4dc4b22258cdc103c1577', true, 'CATEGORY_RESEARCH:CRYPTO', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),
  ('LlamaLoco0000', '0x93fb8127a1b21a112b11af936361225df0563e4a', true, 'CATEGORY_RESEARCH:CRYPTO,WORLD_POLITICS', 'RESEARCH', 'Research-only candidate shared by Crypto and World/Politics; no follower created.', null, null),

  -- MENTIONS
  ('poorsob', '0x2785e7022dc20757108204b13c08cea8613b70ae', true, 'CATEGORY_RESEARCH:MENTIONS', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),
  ('NotBakerMcKenzie', '0xd99f3bec8e060ada0aef0c4057695dd5bc22fcdc', true, 'CATEGORY_RESEARCH:MENTIONS', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),
  ('tripping', '0x6480542954b70a674a74bd1a6015dec362dc8dc5', true, 'CATEGORY_RESEARCH:MENTIONS', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),

  -- WORLD / POLITICS
  ('TheQuietRisk', '0x0a854897a06d4999e5b2dde5693609f1428ffe9d', true, 'CATEGORY_RESEARCH:WORLD_POLITICS', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null),
  ('LinaBell', '0xf0ed9e68e6cd3ee712260abeaec32de56a7d47d8', true, 'CATEGORY_RESEARCH:WORLD_POLITICS', 'RESEARCH', 'Research-only category candidate; no follower created.', null, null)
ON CONFLICT (handle) DO NOTHING;

# Channel post reactions — backend 1.2.20

Migration `0033_channel_post_reactions.sql` adds one reaction per user per channel post with a five-emoji allowlist, cascading cleanup, RLS, and service-role-only database privileges. The authenticated channel API enriches post responses with reaction counts and the current user's selection and accepts a validated PUT endpoint to set or clear a reaction.

This change has not been applied to a live database. Validate migration and routes against staging and multiple signed-in accounts before deployment.

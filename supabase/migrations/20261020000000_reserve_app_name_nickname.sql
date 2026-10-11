-- The app is now called Clash of Capitals. Its name joins the nicknames that would impersonate
-- staff, next to the previous name ('businessbanker'), which stays reserved.
-- Additive: no existing profile is changed, and the check runs only when a nickname is set.
insert into public.nickname_blocklist (term, match) values ('clashofcapitals', 'exact')
on conflict (term) do nothing;

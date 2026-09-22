{
  contribs.shares = {
    # No `src`: this contrib is UI-ONLY for now. Its service half still lives in
    # services/broker/broker/shares/ and moves once the broker surface can carry
    # a contrib's own router, settings and tables. Why: PR #602.
    ui.panels = [{
      id = "shares";
      title = "Shares";
      entry = ./ui/SharesPanel.tsx;
      # After the app's own tabs; shares is informational, not a gate.
      order = 50;
    }];
  };
}

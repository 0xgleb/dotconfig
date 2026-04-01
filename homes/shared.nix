{ userConfig, ... }:

{
  programs.home-manager.enable = true;

  programs.git = {
    enable = true;
    settings = {
      user.name = userConfig.name;
      init.defaultBranch = "master";
      push.autoSetupRemote = true;
    };
  };

  programs.difftastic = {
    enable = true;
    git.enable = true;
    git.diffToolMode = true;
  };

  programs.direnv.enable = true;
  programs.direnv.nix-direnv.enable = true;
  programs.direnv.config.global.hide_env_diff = true;

  programs.zoxide.enable = true;
  programs.fzf.enable = true;
  programs.carapace.enable = true;
}

{ modulesPath, ... }: {
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];

  boot.loader.grub = {
    enable = true;
    efiSupport = false;
    devices = [ ]; # Disko will populate this
  };

  # DigitalOcean does NOT serve DHCP for the public interface; it injects the
  # network config via cloud-init metadata. With networking.useDHCP the box comes
  # up with no/garbage networking after the first reboot and is unreachable (no
  # SSH, never joins the tailnet). cloud-init's DigitalOcean datasource renders
  # the correct static config instead. See nix-community/nixos-anywhere-examples#5.
  networking.useDHCP = false;

  services.cloud-init = {
    enable = true;
    network.enable = true;
    settings = {
      datasource_list = [ "DigitalOcean" ];
      datasource.DigitalOcean = { };
    };
  };

  # Disko configuration for disk partitioning
  disko.devices = {
    disk.main = {
      device = "/dev/vda";
      type = "disk";
      content = {
        type = "gpt";
        partitions = {
          boot = {
            size = "1M";
            type = "EF02";
          };
          root = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/";
            };
          };
        };
      };
    };
  };
}

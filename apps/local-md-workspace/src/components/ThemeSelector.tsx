import type { ComponentProps } from "react";
import { CheckIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import { themeDefinitions, useTheme, type ThemeDefinition } from "@/theme";

type ThemeSelectorProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "onClick"
> & {
  menuAlign?: "start" | "center" | "end";
};

export function ThemeSelector({
  menuAlign = "end",
  size = "icon-sm",
  variant = "ghost",
  ...props
}: ThemeSelectorProps) {
  let { t } = useI18n();
  let { themeDefinition } = useTheme();
  let label = t("theme.selector.label", { label: themeDefinition.label });

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button aria-label={label} size={size} variant={variant} {...props}>
              <PaletteIcon data-icon="inline-start" />
              <span className="sr-only">{label}</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={menuAlign} className="min-w-56" sideOffset={8}>
        <DropdownMenuLabel>{t("theme.selector.group")}</DropdownMenuLabel>
        <DropdownMenuGroup>
          <ThemeMenuItems itemClassName={themeDropdownItemClassName} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ThemeDropdownSubmenuProps = {
  itemClassName?: string;
};

export function ThemeDropdownSubmenu({ itemClassName }: ThemeDropdownSubmenuProps) {
  let { t } = useI18n();
  let { themeDefinition } = useTheme();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={itemClassName}>
        <PaletteIcon data-icon="inline-start" />
        {t("theme.selector.group")}
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {themeDefinition.label}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56" sideOffset={8}>
        <DropdownMenuGroup>
          <ThemeMenuItems itemClassName={themeDropdownItemClassName} />
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

type ThemeMenuItemsProps = {
  itemClassName: string;
};

function ThemeMenuItems({ itemClassName }: ThemeMenuItemsProps) {
  let { setTheme, theme } = useTheme();

  return (
    <>
      {themeDefinitions.map((definition) => {
        let active = definition.id == theme;
        let Icon = themeIcon(definition);
        return (
          <DropdownMenuItem
            key={definition.id}
            aria-current={active ? "true" : undefined}
            className={itemClassName}
            onSelect={() => setTheme(definition.id)}
          >
            <Icon data-icon="inline-start" />
            <span className="min-w-0 flex-1 truncate">{definition.label}</span>
            {active && <CheckIcon className="ml-auto text-primary" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function themeIcon(definition: ThemeDefinition) {
  return definition.appearance == "dark" ? MoonIcon : SunIcon;
}

const themeDropdownItemClassName = "min-h-9 px-2.5 py-2";

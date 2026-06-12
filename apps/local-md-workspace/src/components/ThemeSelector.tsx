import type { ComponentProps } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { CheckIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { themeDefinitions, useTheme, type ThemeDefinition } from "@/theme";

type ThemeSelectorProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "onClick"
>;

export function ThemeSelector({
  size = "icon-sm",
  variant = "ghost",
  ...props
}: ThemeSelectorProps) {
  let { themeDefinition } = useTheme();
  let label = `Theme: ${themeDefinition.label}`;

  return (
    <DropdownMenuPrimitive.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button aria-label={label} size={size} variant={variant} {...props}>
              <PaletteIcon data-icon="inline-start" />
              <span className="sr-only">{label}</span>
            </Button>
          </DropdownMenuPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          className={themeDropdownContentClassName}
          sideOffset={8}
        >
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Theme</div>
          <ThemeMenuItems itemClassName={themeDropdownItemClassName} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

type ThemeDropdownSubmenuProps = {
  itemClassName?: string;
};

export function ThemeDropdownSubmenu({ itemClassName }: ThemeDropdownSubmenuProps) {
  let { themeDefinition } = useTheme();

  return (
    <DropdownMenuPrimitive.Sub>
      <DropdownMenuPrimitive.SubTrigger className={itemClassName}>
        <PaletteIcon data-icon="inline-start" />
        Theme
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {themeDefinition.label}
        </span>
      </DropdownMenuPrimitive.SubTrigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.SubContent className={themeDropdownContentClassName} sideOffset={8}>
          <ThemeMenuItems itemClassName={themeDropdownItemClassName} />
        </DropdownMenuPrimitive.SubContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Sub>
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
          <DropdownMenuPrimitive.Item
            key={definition.id}
            aria-current={active ? "true" : undefined}
            className={itemClassName}
            onSelect={() => setTheme(definition.id)}
          >
            <Icon data-icon="inline-start" />
            <span className="min-w-0 flex-1 truncate">{definition.label}</span>
            {active && <CheckIcon className="ml-auto size-4 text-primary" />}
          </DropdownMenuPrimitive.Item>
        );
      })}
    </>
  );
}

function themeIcon(definition: ThemeDefinition) {
  return definition.appearance == "dark" ? MoonIcon : SunIcon;
}

const themeDropdownContentClassName =
  "z-50 flex min-w-56 max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const themeDropdownItemClassName = cn(
  "flex min-h-9 cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none select-none",
  "data-[highlighted]:bg-muted data-[highlighted]:text-foreground",
  "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
);

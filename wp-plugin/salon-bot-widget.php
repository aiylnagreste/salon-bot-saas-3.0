<?php
/**
 * Plugin Name: Salon Bot receptionist chat & call widget
 * Description: Embeds the Salon Bot chat widget on every page of your WordPress site.
 * Version:     1.0.0
 * Author:      wpsqr
 */

if ( ! defined( 'ABSPATH' ) ) exit; // Prevent direct file access

// ─── Constants ────────────────────────────────────────────────────────────────
define( 'SALONBOT_OPTION', 'salonbot_settings' );
define( 'SALONBOT_MENU_SLUG', 'salonbot-settings' );

// ─── Defaults ─────────────────────────────────────────────────────────────────
function salonbot_defaults() {
    return [
        'server_url'    => '',
        'bot_name'      => 'Salon Assistant',
        'primary_color' => '#5a5a40',
        'enabled'       => '1',
    ];
}

function salonbot_get( $key ) {
    $opts = get_option( SALONBOT_OPTION, salonbot_defaults() );
    $opts = wp_parse_args( $opts, salonbot_defaults() );
    return isset( $opts[ $key ] ) ? $opts[ $key ] : '';
}

// ─── Inject widget script in footer ───────────────────────────────────────────
add_action( 'wp_footer', 'salonbot_inject_widget' );
function salonbot_inject_widget() {
    if ( salonbot_get('enabled') !== '1' ) return;

    $server_url    = trailingslashit( esc_url( salonbot_get('server_url') ) );
    $bot_name      = esc_attr( salonbot_get('bot_name') );
    $primary_color = esc_attr( salonbot_get('primary_color') );

    if ( empty($server_url) || $server_url === '/' ) return;

    // Script source served by your Node server
    $script_src = $server_url . 'widget.js';

    echo "\n<!-- Salon Bot Widget -->\n";

    // Fix emoji / font display (same as you already did)
    echo '<style>
        #salonbot-wrap {
            position: fixed !important;
            bottom: 24px !important;
            right: 24px !important;
            z-index: 2147483647 !important;
        }
        #salonbot-wrap img,
        #salonbot-wrap img.emoji {
            height: 1em !important;
            width: auto !important;
            max-height: 1.2em !important;
            vertical-align: middle !important;
            display: inline-block !important;
        }
    </style>' . "\n";

    // ✅ NO `defer`
    // ✅ Inject backend URL, bot name, color
    echo '<script 
        src="' . $script_src . '"
        data-backend-url="' . $server_url . '"
        data-bot-name="' . $bot_name . '"
        data-primary-color="' . $primary_color . '"
    ></script>' . "\n";
}

// ─── Admin menu ───────────────────────────────────────────────────────────────
add_action( 'admin_menu', 'salonbot_add_menu' );
function salonbot_add_menu() {
    add_options_page(
        'Salon Bot Widget',
        'Salon Bot',
        'manage_options',
        SALONBOT_MENU_SLUG,
        'salonbot_settings_page'
    );
}

// ─── Register settings ────────────────────────────────────────────────────────
add_action( 'admin_init', 'salonbot_register_settings' );
function salonbot_register_settings() {
    register_setting( SALONBOT_OPTION, SALONBOT_OPTION, 'salonbot_sanitize' );
}

function salonbot_sanitize( $input ) {
    $clean = salonbot_defaults();

    $clean['server_url'] = esc_url_raw( trim( $input['server_url'] ?? '' ) );
    $clean['bot_name']   = sanitize_text_field( $input['bot_name'] ?? 'Salon Assistant' );

    // Validate hex colour
    $color = sanitize_hex_color( $input['primary_color'] ?? '#5a5a40' );
    $clean['primary_color'] = $color ? $color : '#5a5a40';

    $clean['enabled'] = ! empty( $input['enabled'] ) ? '1' : '0';

    return $clean;
}

// ─── Settings page HTML ───────────────────────────────────────────────────────
function salonbot_settings_page() {
    if ( ! current_user_can('manage_options') ) return;

    $saved = get_option( SALONBOT_OPTION, [] );
    $opts  = wp_parse_args( $saved, salonbot_defaults() );

    $server_url    = esc_attr( $opts['server_url'] );
    $bot_name      = esc_attr( $opts['bot_name'] );
    $primary_color = esc_attr( $opts['primary_color'] );
    $enabled       = $opts['enabled'] === '1';

    // Show success notice after save
    if ( isset( $_GET['settings-updated'] ) ) {
        echo '<div class="notice notice-success is-dismissible"><p><strong>Salon Bot settings saved.</strong></p></div>';
    }
    ?>
    <div class="wrap">
        <h1>Salon Bot Widget</h1>
        <p>Configure and embed the Salon Bot chat widget on every page of your site.</p>

        <form method="post" action="options.php">
            <?php settings_fields( SALONBOT_OPTION ); ?>

            <table class="form-table" role="presentation">

                <tr>
                    <th scope="row"><label for="salonbot_enabled">Enable Widget</label></th>
                    <td>
                        <input type="checkbox"
                               id="salonbot_enabled"
                               name="<?= SALONBOT_OPTION ?>[enabled]"
                               value="1"
                               <?php checked( $enabled ); ?> />
                        <p class="description">Uncheck to hide the widget without deleting your settings.</p>
                    </td>
                </tr>

                <tr>
                    <th scope="row"><label for="salonbot_url">Bot Server URL <span style="color:red">*</span></label></th>
                    <td>
                        <input type="url"
                               id="salonbot_url"
                               name="<?= SALONBOT_OPTION ?>[server_url]"
                               value="<?= $server_url ?>"
                               class="regular-text"
                               placeholder="https://your-app.up.railway.app"
                               required />
                        <p class="description">
                            The URL where your Salon Bot server is deployed.<br>
                            The widget script will be loaded from <code>{Server URL}/widget.js</code>.
                        </p>
                    </td>
                </tr>

                <tr>
                    <th scope="row"><label for="salonbot_name">Bot Name</label></th>
                    <td>
                        <input type="text"
                               id="salonbot_name"
                               name="<?= SALONBOT_OPTION ?>[bot_name]"
                               value="<?= $bot_name ?>"
                               class="regular-text"
                               placeholder="Salon Assistant" />
                        <p class="description">Displayed in the chat window header.</p>
                    </td>
                </tr>

                <tr>
                    <th scope="row"><label for="salonbot_color">Primary Colour</label></th>
                    <td>
                        <input type="color"
                               id="salonbot_color"
                               name="<?= SALONBOT_OPTION ?>[primary_color]"
                               value="<?= $primary_color ?>" />
                        <code style="margin-left:8px" id="salonbot_color_hex"><?= $primary_color ?></code>
                        <p class="description">Accent colour for the chat button and message bubbles.</p>
                        <script>
                            document.getElementById('salonbot_color').addEventListener('input', function() {
                                document.getElementById('salonbot_color_hex').textContent = this.value;
                            });
                        </script>
                    </td>
                </tr>

            </table>

            <?php if ( $server_url ) : ?>
            <div style="background:#f6f7f7;border:1px solid #ddd;border-radius:4px;padding:12px 16px;margin:16px 0;max-width:600px">
                <strong>Embed code (if you prefer manual placement):</strong>
                <pre style="margin:8px 0 0;font-size:12px;overflow-x:auto">&lt;script src="<?= esc_html( trailingslashit($server_url) . 'widget.js' ) ?>"
        data-bot-name="<?= esc_html($bot_name) ?>"
        data-primary-color="<?= esc_html($primary_color) ?>"&gt;&lt;/script&gt;</pre>
            </div>
            <?php endif; ?>

            <?php submit_button( 'Save Settings' ); ?>
        </form>
    </div>
    <?php
}

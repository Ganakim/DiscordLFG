require('dotenv').config()

const {Client, GatewayIntentBits, SlashCommandBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, EmbedBuilder, StringSelectMenuBuilder} = require('discord.js')

// Bot configuration
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
})

// Get game roles from the server
function getGameRoles(guild){
  return guild.roles.cache.filter(role=>role.color === 0 && !['@everyone', 'Admin', 'Moderator', 'Bot', 'PartyFinder'].includes(role.name) && !role.managed)
}

// Get party categories
function getPartyCategories(guild){
  return guild.channels.cache.filter(channel=>channel.type === ChannelType.GuildCategory && channel.name.toLowerCase().includes('party'))
}

// Register slash commands
async function registerCommands(){
  const commands = [
    new SlashCommandBuilder()
      .setName('lfg')
      .setDescription('Create a Looking for Group party')
      .addStringOption(option=>option.setName('game')
        .setDescription('The game you want to play')
        .setRequired(true)
        .setAutocomplete(true))
      .addIntegerOption(option=>option.setName('limit')
        .setDescription('Voice channel user limit (default: no limit)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(99))
      .addBooleanOption(option=>option.setName('ping')
        .setDescription('Ping users with the matching game role (default: true)')
        .setRequired(false)),

    new SlashCommandBuilder()
      .setName('close_party')
      .setDescription('Close your party')
      .addStringOption(option=>option.setName('category')
        .setDescription('The category of the party to close')
        .setRequired(true)
        .setAutocomplete(true))
  ]

  try{
    console.log('Started refreshing application (/) commands.')
    await client.application.commands.set(commands)
    console.log('Successfully reloaded application (/) commands.')
  }catch(error){
    console.error('Error refreshing commands:', error)
  }
}

const remakeRolesChannel = false

// Bot ready event
client.once('ready', async()=>{
  console.log(`Logged in as ${client.user.tag}!`)
  await registerCommands()
  if(remakeRolesChannel){
    const guild = client.guilds.cache.first()
    // the "get-roles" channel should have a few specific messages. The first is about color roles, the second is for game roles. There should be no other messages.
    const getRolesChannel = guild.channels.cache.find(c=>c.name === 'get-roles')
    if(!getRolesChannel) return
    // remove any existing messages in the channel
    const messages = await getRolesChannel.messages.fetch()
    await Promise.all(messages.map(message=>message.delete()))
    const colors = ['Red', 'Green', 'Blue', 'Yellow', 'Orange', 'Purple', 'Teal', 'Pink']
    const colorSelectMenu = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_color_role')
          .setPlaceholder('Select your color role...')
          .addOptions(
            colors.map(color=>({
              label: `${color}`,
              value: color
            }))
          )
      )

    await getRolesChannel.send({
      embeds: [{
        title: '🎨 Color Role',
        description: '🌈 Changes the color of your username in the server! 🌈',
        color: 0x5865F2
      }],
      components: [colorSelectMenu]
    })

    const gameRoles = getGameRoles(guild)
    const gameSelectMenu = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_game_roles')
          .setPlaceholder('Select your game roles...')
          .setMinValues(0)
          .setMaxValues(gameRoles.size)
          .addOptions(
            gameRoles.map(role=>({
              label: `${role.name}`,
              value: role.id
            }))
          )
      )

    await getRolesChannel.send({
      embeds: [{
        title: '🎮 Game Roles',
        description: '📢 Get notified when people are looking for a group! 📢',
        color: 0x5865F2
      }],
      components: [gameSelectMenu]
    })
  }
})

// Handle regular messages - delete them if they're in the lfg channel
client.on('messageCreate', async message=>{
  // Ignore bot messages and system messages
  if(message.author.bot || message.system) return

  // Delete regular messages in the lfg channel
  if(message.channel.name === 'lfg'){
    try{
      await message.delete()
      // Send ephemeral-style warning (will auto-delete after a few seconds, since we can't use ephemeral messages in regular channels)
      const warningMessage = await message.channel.send(`${message.author}, please use the \`/lfg\` command instead of regular messages in this channel.`)
      setTimeout(()=>{
        warningMessage.delete().catch(()=>{}) // Ignore errors if message is already deleted
      }, 5000) // Delete after 5 seconds
    }catch(error){
      // Ignore errors (message might already be deleted)
    }
  }
})

// Handle autocomplete for game names
client.on('interactionCreate', async interaction=>{
  if(!interaction.isAutocomplete()) return

  if(interaction.commandName === 'lfg'){
    const focusedValue = interaction.options.getFocused()
    const gameRoles = getGameRoles(interaction.guild)

    const filtered = gameRoles
      .filter(role=>role.name.toLowerCase().includes(focusedValue.toLowerCase()))
      .first(25) // Discord limits to 25 choices
      .map(r=>({name:r.name, value:r.name}))

    await interaction.respond(filtered)
  }else if(interaction.commandName === 'close_party'){
    // return a list of categories that have the word "party" in their name
    const focusedValue = interaction.options.getFocused()
    const categories = getPartyCategories(interaction.guild)

    const filtered = categories
      .filter(category=>category.name.toLowerCase().includes(focusedValue.toLowerCase()))
      .slice(0, 25) // Limit to 25 choices
      .map(c=>({name:c.name, value:c.id}))
    await interaction.respond(filtered)
  }
})

// Handle slash commands
client.on('interactionCreate', async interaction=>{
  if(interaction.isCommand()){
    if(interaction.commandName === 'lfg'){
      if(interaction.channel.name != 'lfg'){
        return interaction.reply({
          content: 'This command can only be used in the #lfg channel.',
          flags: MessageFlags.Ephemeral
        })
      }
      await handleLFGCommand(interaction)
    }else if(interaction.commandName === 'close_party'){
      const closed = await cleanupParty(interaction.user.id, interaction.options.getString('category'), interaction.guild)
      if(closed) await interaction.reply({content:'Closing party...', flags:MessageFlags.Ephemeral})
    }else if(interaction.commandName === 'role'){
      // can have 4 sub commands, add(adds the role to the user), remove(removes it from them), create(admins only, creates a role), destroy(admins only, deletes a role)
      const subCommand = interaction.options.getSubcommand()
      const roleName = interaction.options.getString('role')
      const role = interaction.guild.roles.cache.find(r=>r.name.toLowerCase() === roleName.toLowerCase())
      if(subCommand === 'add'){
        if(role){
          await interaction.member.roles.add(role)
          await interaction.reply({content:`✅ Added role **${role.name}**`, ephemeral:true})
        }else{
          await interaction.reply({content:`❌ Role **${roleName}** not found`, ephemeral:true})
        }
      }else if(subCommand === 'remove'){
        if(role){
          await interaction.member.roles.remove(role)
          await interaction.reply({content:`✅ Removed role **${role.name}**`, ephemeral:true})
        }else{
          await interaction.reply({content:`❌ Role **${roleName}** not found`, ephemeral:true})
        }
      }else if(subCommand === 'create'){
        if(interaction.member.permissions.has('ManageRoles')){
          if(role){
            await interaction.reply({content:`❌ Role **${roleName}** already exists`, ephemeral:true})
          }else{
            const newRole = await interaction.guild.roles.create({
              name: roleName,
              color: 0,
              reason: `Role created by ${interaction.user.tag}`
            })
            await interaction.reply({content:`✅ Created role **${newRole.name}**`, ephemeral:true})
          }
        }else{
          await interaction.reply({content:'❌ You do not have permission to create roles', ephemeral:true})
        }
      }else if(subCommand === 'destroy'){
        if(interaction.member.permissions.has('ManageRoles')){
          if(role){
            await role.delete(`Role deleted by ${interaction.user.tag}`)
            await interaction.reply({content:`✅ Deleted role **${role.name}**`, ephemeral:true})
          }else{
            await interaction.reply({content:`❌ Role **${roleName}** not found`, ephemeral:true})
          }
        }else{
          await interaction.reply({content:'❌ You do not have permission to delete roles', ephemeral:true})
        }
      }
    }
  }else if(interaction.isButton()){
    if(interaction.customId.startsWith('close_party_')){
      const partyId = interaction.customId.replace('close_party_', '')
      const closed = await cleanupParty(interaction.user.id, partyId, interaction.guild)
      if(closed) await interaction.reply({content:'Closing party...', flags:MessageFlags.Ephemeral})
    }
  }else if(interaction.isStringSelectMenu()){
    if(interaction.customId === 'select_game_roles'){
      const selectedRoles = interaction.values
      const {member, guild} = interaction
      const gameRoles = getGameRoles(guild)

      // Remove all current game roles
      const currentRoles = member.roles.cache.filter(role=>gameRoles.has(role.id))
      await member.roles.remove(currentRoles)

      // Add selected roles
      const rolesToAdd = selectedRoles.map(roleId=>guild.roles.cache.get(roleId)).filter(role=>role && gameRoles.has(role.id))
      await member.roles.add(rolesToAdd)
      await interaction.reply({
        content: `✅ Updated your game roles: ${rolesToAdd.map(role=>role.name).join(', ')}`,
        flags: MessageFlags.Ephemeral
      })
    }else if(interaction.customId === 'select_color_role'){
      const selectedColor = interaction.values[0]
      const {member, guild} = interaction

      // Remove all current color roles
      const colorRoles = guild.roles.cache.filter(role=>role.color !== 0 && !['@everyone', 'Admin', 'Moderator', 'Bot', 'PartyFinder'].includes(role.name) && !role.managed)
      const currentRoles = member.roles.cache.filter(role=>colorRoles.has(role.id))
      await member.roles.remove(currentRoles)

      // Add selected color role
      const roleToAdd = guild.roles.cache.find(role=>role.name === `Color:${selectedColor}`)
      if(roleToAdd && colorRoles.has(roleToAdd.id)){
        await member.roles.add(roleToAdd)
        await interaction.reply({
          content: `✅ Updated your color role: ${roleToAdd.name}`,
          flags: MessageFlags.Ephemeral
        })
      }else{
        await interaction.reply({
          content: '❌ No valid color role selected.',
          flags: MessageFlags.Ephemeral
        })
      }
    }
  }
})

// Handle LFG command
async function handleLFGCommand(interaction){
  await interaction.deferReply()

  const gameName = interaction.options.getString('game').charAt(0).toUpperCase() + interaction.options.getString('game').slice(1)
  const limit = interaction.options.getInteger('limit') || 0
  const shouldPing = interaction.options.getBoolean('ping') ?? true
  const {user} = interaction

  try{
    const {guild} = interaction
    const partyName = `${user.displayName}'s ${gameName} party`

    // Create category
    const category = await guild.channels.create({
      name: partyName,
      type: ChannelType.GuildCategory
    })

    // Create text channel
    const textChannel = await guild.channels.create({
      name: 'text',
      type: ChannelType.GuildText,
      parent: category
    })

    // Create voice channel
    const voiceChannel = await guild.channels.create({
      name: 'voice',
      type: ChannelType.GuildVoice,
      parent: category,
      userLimit: limit
    })

    // Ping users with matching game role if requested
    let pingMessage = ''
    if(shouldPing){
      const gameRole = guild.roles.cache.find(role=>role.name.toLowerCase() === gameName.toLowerCase() && getGameRoles(guild).has(role.id))

      if(gameRole){
        pingMessage = `\n${gameRole} - New party created!`
      }
    }

    // Create embed for the command reply
    const replyEmbed = new EmbedBuilder()
      .setTitle(`🎮 ${partyName}`)
      .setDescription(`Looking for players for **${gameName}**!`)
      .addFields(
        {name:'👥 Limit', value:limit > 0 ? `${limit} players` : 'No limit'},
        {name:'🤝 Join us!', value:`${textChannel}`}
      )
      .setColor(0x00AE86)

    const closeButton = new ButtonBuilder()
      .setCustomId(`close_party_${partyName}`)
      .setLabel('Close Party')
      .setStyle(ButtonStyle.Danger)

    const replyMessage = await interaction.editReply({
      embeds: [replyEmbed],
      components: [new ActionRowBuilder().addComponents(closeButton)],
      content: pingMessage || null,
      ephemeral: false
    })

    // Store message ID in the text channel description for cleanup
    await textChannel.setTopic(`${interaction.channel.id}\u200B${replyMessage.id}`)

    // Auto-cleanup when voice channel becomes empty
    const checkEmpty = setInterval(()=>{
      const vc = guild.channels.cache.get(voiceChannel.id)
      if(!vc || vc.members.size === 0){
        setTimeout(()=>{
          const vcRecheck = guild.channels.cache.get(voiceChannel.id)
          if(!vcRecheck || vcRecheck.members.size === 0){
            cleanupParty(interaction.user.id, partyName, guild)
            clearInterval(checkEmpty)
          }
        }, 30000) // Wait 30 seconds before cleanup
      }
    }, 60000) // Check every minute

    // Cleanup after 24 hours regardless
    setTimeout(()=>{
      cleanupParty(partyName, guild)
      clearInterval(checkEmpty)
    }, 24 * 60 * 60 * 1000)
  }catch(error){
    console.error('Error creating party:', error)
    await interaction.editReply({
      content: '❌ Error creating party. Please try again.',
      flags: MessageFlags.Ephemeral
    })
  }
}

// Clean up party channels
async function cleanupParty(userId, partyName, guild){
  if(!userId) return
  if(!partyName) return
  if(!guild) return

  try{
    const category = guild.channels.cache.find(c=>c.type === ChannelType.GuildCategory && c.name == partyName)
    if(!category) return
    const textChannel = category.children.cache.find(c=>c.type === ChannelType.GuildText)
    const voiceChannel = category.children.cache.find(c=>c.type === ChannelType.GuildVoice)
    const topic = textChannel.topic.split('\u200B')
    const lfgMessageChannel = guild.channels.cache.get(topic[0])
    const lfgMessage = await lfgMessageChannel.messages.fetch(topic[1])

    if(lfgMessage.interaction.user.id !== userId) return false

    await textChannel.delete()
    await voiceChannel.delete()
    await lfgMessage.delete()
    await category.delete()

    return true
  }catch(error){
    console.error('Error cleaning up party:', error)
  }
}

// Login with your bot token
client.login(process.env.BOT_TOKEN)

// Export for testing
module.exports = {client}

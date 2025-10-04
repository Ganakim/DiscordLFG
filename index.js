require('dotenv').config()

const {Client, GatewayIntentBits, SlashCommandBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits} = require('discord.js')

// Bot configuration
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  allowedMentions: {parse:['users', 'roles'], repliedUser:true}
})

// Get game roles from the server
function getGameRoles(guild){
  return guild.roles.cache.filter(role=>role.color === 0 && !['@everyone', 'Admin', 'Moderator', 'Bot', 'PartyFinder'].includes(role.name) && !role.managed)
}

// Get party categories
function getPartyCategories(guild){
  return guild.channels.cache.filter(channel=>channel.type === ChannelType.GuildCategory && channel.name.endsWith('party'))
}

// Register slash commands
async function registerCommands(){
  const commands = [
    new SlashCommandBuilder().setName('lfg')
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

    new SlashCommandBuilder().setName('close_party')
      .setDescription('Close your party')
      .addStringOption(option=>option.setName('party')
        .setDescription('The category of the party to close')
        .setRequired(true)
        .setAutocomplete(true)),

    new SlashCommandBuilder().setName('role')
      .setDescription('Manage roles')
      .addSubcommand(sub=>sub.setName('add')
        .setDescription('Add a role to yourself')
        .addStringOption(option=>option.setName('role')
          .setDescription('The role to add')
          .setRequired(true)))
      .addSubcommand(sub=>sub.setName('remove')
        .setDescription('Remove a role from yourself')
        .addStringOption(option=>option.setName('role')
          .setDescription('The role to remove')
          .setRequired(true)))
      .addSubcommand(sub=>sub.setName('create')
        .setDescription('Create a new role (admins only)')
        .addStringOption(option=>option.setName('role')
          .setDescription('The name of the role to create')
          .setRequired(true)))
      .addSubcommand(sub=>sub.setName('destroy')
        .setDescription('Delete a role (admins only)')
        .addStringOption(option=>option.setName('role')
          .setDescription('The name of the role to delete')
          .setRequired(true))),

    new SlashCommandBuilder().setName('reload')
      .setDescription('Reload the bot commands and messages')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder().setName('claim')
      .setDescription('Claim an abandoned party you were previously in')
      .addStringOption(option=>option.setName('game')
        .setDescription('The new game name for the party (optional)')
        .setRequired(false)
        .setAutocomplete(true))
      .addIntegerOption(option=>option.setName('limit')
        .setDescription('Voice channel user limit (default: no limit)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(99))
      .addBooleanOption(option=>option.setName('ping')
        .setDescription('Ping users with the matching game role (default: true)')
        .setRequired(false))
  ]

  try{
    console.log('Started refreshing application (/) commands.')
    await client.application.commands.set(commands)
    console.log('Successfully reloaded application (/) commands.')
  }catch(error){
    console.error('Error refreshing commands:', error)
  }
}

// Bot ready event
client.once('ready', async()=>{
  console.log(`Logged in as ${client.user.tag}!`)
  await registerCommands()
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
  const focusedOption = interaction.options.getFocused(true) // { name, value }
  if(focusedOption.name === 'game'){
    const focusedValue = interaction.options.getFocused()
    const gameRoles = getGameRoles(interaction.guild)

    const filtered = gameRoles
      .filter(role=>role.name.toLowerCase().includes(focusedValue.toLowerCase()))
      .first(25) // Discord limits to 25 choices
      .map(r=>({name:r.name, value:r.name}))

    await interaction.respond(filtered)
  }else if(focusedOption.name === 'party'){
    // return a list of categories that have the word "party" in their name
    const focusedValue = interaction.options.getFocused()
    const categories = getPartyCategories(interaction.guild)
    const filtered = categories
      .filter(category=>category.name.toLowerCase().includes(focusedValue.toLowerCase()))
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
      await createParty(interaction)
    }else if(interaction.commandName === 'close_party'){
      console.log(`Closing party: ${interaction.options.getString('category')} by ${interaction.user.tag}`)
      const closed = await cleanupParty(interaction.user.id, interaction.options.getString('category'), interaction.guild)
      if(closed) await interaction.reply({content:'Party closed.', flags:MessageFlags.Ephemeral})
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
    }else if(interaction.commandName === 'reload'){
      if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)){
        return interaction.reply({
          content: '❌ You do not have permission to manage messages',
          flags: MessageFlags.Ephemeral
        })
      }
      await registerCommands()
      const guild = client.guilds.cache.first()
      // the "get-roles" channel should have a few specific messages. The first is about color roles, the second is for game roles. There should be no other messages.
      const rolesChannel = guild.channels.cache.find(c=>c.name === 'get-roles')
      if(!rolesChannel) return
      // remove any existing messages in the channel
      const roleMessages = await rolesChannel.messages.fetch()
      await Promise.all(roleMessages.map(message=>message.delete()))
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

      await rolesChannel.send({
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

      await rolesChannel.send({
        embeds: [{
          title: '🎮 Game Roles',
          description: '📢 Get notified when people are looking for a group! 📢',
          color: 0x5865F2
        }],
        components: [gameSelectMenu]
      })

      const lfgChannel = guild.channels.cache.find(c=>c.name === 'lfg')
      if(!lfgChannel) return
      // find the first message. create/update it to explain the /lfg and /close_party commands
      const firstMessage = await lfgChannel.messages.fetch({limit:1}).then(messages=>messages.filter(m=>!m.content).first())
      const lfgMessage = {
        embeds: [{
          title: 'Looking for Group (LFG)',
          description: 'Use the `/lfg` command to create a new party.\nIf your game isn\'t in the list, that\'s ok! A party can be created for anything.\nYou can close your party with the red "Close Party" button, or with the /close_party command.',
          color: 0x5865F2
        }]
      }
      if(firstMessage) await firstMessage.edit(lfgMessage)
      else await lfgChannel.send(lfgMessage)

      interaction.reply({
        content: 'Messages reloaded',
        flags: MessageFlags.Ephemeral
      })
    }else if(interaction.commandName == 'claim'){
      await claimParty(interaction, interaction.options.getString('game'), interaction.options.getInteger('limit'), interaction.options.getBoolean('ping'))
    }
  }else if(interaction.isButton()){
    if(interaction.customId.startsWith('close_party_')){
      const partyId = interaction.customId.replace('close_party_', '')
      console.log(`Closing party: ${partyId} by ${interaction.user.tag}`)
      const closed = await cleanupParty(interaction.user.id, partyId, interaction.guild)
      if(closed) await interaction.reply({content:'Party closed.', flags:MessageFlags.Ephemeral})
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

// Handle voice state updates
client.on('voiceStateUpdate', oldState=>{
  // ignore any voice channel that isn't in a category where the name ends with "party"
  const voiceChannel = oldState.channel
  const category = voiceChannel?.parent
  if(!voiceChannel || !category || !category.name.endsWith('party')) return

  if(voiceChannel.members.filter(m=>!m.user.bot).size === 0){
    // Cleanup party if the voice channel is empty. Use the bot's ID as the user ID
    console.log(`Voice channel ${voiceChannel.name} is empty, cleaning up party: ${category.name}`)
    cleanupParty(client.user.id, category.id, oldState.guild)
  }
})

// Handle LFG command
async function createParty(interaction){
  const gameName = interaction.options.getString('game').charAt(0).toUpperCase() + interaction.options.getString('game').slice(1)
  const limit = interaction.options.getInteger('limit') || 0
  let shouldPing = interaction.options.getBoolean('ping') ?? true
  const {user} = interaction

  await interaction.deferReply({flags:MessageFlags.Ephemeral})

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
    await textChannel.setTopic(`${user.id}`)

    // Create voice channel
    const voiceChannel = await guild.channels.create({
      name: 'voice',
      type: ChannelType.GuildVoice,
      parent: category,
      userLimit: limit
    })

    // Ping users with matching game role if requested
    const gameRole = guild.roles.cache.find(role=>role.name.toLowerCase() === gameName.toLowerCase() && getGameRoles(guild).has(role.id)) || ''
    if(!gameRole) shouldPing = false

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
      .setCustomId(`close_party_${category.id}`)
      .setLabel('Close Party')
      .setStyle(ButtonStyle.Danger)

    if(shouldPing) await textChannel.send({content:gameRole.toString()})

    const replyMessage = await interaction.editReply({
      embeds: [replyEmbed],
      components: [new ActionRowBuilder().addComponents(closeButton)]
    })

    // Store message ID in the text channel description for cleanup
    await textChannel.setTopic(`${user.id}\u200B${interaction.channel.id}\u200B${replyMessage.id}`)

    setTimeout(async()=>{
      if(!voiceChannel || voiceChannel.members.size === 0){
        cleanupParty(client.user.id, category.id, guild)
      }
    }, 60000)
  }catch(error){
    console.error('Error creating party:', error)
    await interaction.editReply({
      content: '❌ Error creating party. Please try again.',
      flags: MessageFlags.Ephemeral
    })
  }
}

// Claim/remake a party
async function claimParty(interaction, gameName = null, limit = null, shouldPing = true){
  const {user, guild} = interaction
  await interaction.deferReply({flags:MessageFlags.Ephemeral})

  const category = interaction.channel.parent
  if(!category || category.type !== ChannelType.GuildCategory) return interaction.editReply({content:'❌ This command can only be used in a party channel or with a valid category ID.'})

  const textChannel = category.children.cache.find(c=>c.type === ChannelType.GuildText)
  const voiceChannel = category.children.cache.find(c=>c.type === ChannelType.GuildVoice)

  const [originalUserId, interactionChannelId] = textChannel.topic.split('\u200B')

  // check if the original owner is in the vc
  if(voiceChannel.members.has(originalUserId) && originalUserId !== user.id) return interaction.editReply({content:'❌ This party is still in use.'})
  if(!voiceChannel.members.has(user.id)) return interaction.editReply({content:'❌ You must be in the party voice channel to claim it.'})

  console.log(`Claiming party: ${category.name} by ${user.displayName}`)
  gameName = gameName.charAt(0).toUpperCase() + gameName.toLowerCase().slice(1)
  const interactionChannel = guild.channels.cache.get(interactionChannelId)
  if(!interactionChannel) return interaction.editReply({content:'❌ Original interaction channel not found, cannot claim party.'})

  const gameRole = guild.roles.cache.find(role=>role.name.toLowerCase() === gameName.toLowerCase() && getGameRoles(guild).has(role.id)) || ''

  if(!gameRole) shouldPing = false
  if(shouldPing) await textChannel.send({content:gameRole.toString()})

  if(limit !== null) await voiceChannel.setUserLimit(limit)

  // replace the original user's username in the party name
  const newPartyName = `${user.displayName}'s ${gameName} party`
  await category.setName(newPartyName)
  // update the topic to the new user's ID
  await textChannel.setTopic(`${user.id}\u200B${interactionChannelId}`)

  await interaction.editReply({content:`✅ You have claimed the party: ${category.name}`})
  return true
}

// Clean up party channels
async function cleanupParty(userId, categoryId, guild){
  if(!userId){
    console.warn('cleanupParty called without userId, skipping cleanup')
    return
  }
  if(!categoryId){
    console.warn('cleanupParty called without categoryId, skipping cleanup')
    return
  }
  if(!guild){
    console.warn('cleanupParty called without guild, skipping cleanup')
    return
  }

  try{
    const category = guild.channels.cache.find(c=>c.type === ChannelType.GuildCategory && c.id === categoryId)
    if(!category){
      console.warn(`No category found for party: ${categoryId}`)
      return
    }
    const textChannel = category.children.cache.find(c=>c.type === ChannelType.GuildText)
    const voiceChannel = category.children.cache.find(c=>c.type === ChannelType.GuildVoice)
    const topic = textChannel.topic.split('\u200B')
    const originalUserId = topic[0]

    if(userId !== originalUserId && userId !== client.user.id){
      console.warn(`User ${userId} is not the original creator of the party ${categoryId}, skipping cleanup, must be ${originalUserId} or ${client.user.id}`)
      return
    }

    if(topic.length > 2){
      const lfgMessageChannel = guild.channels.cache.get(topic[1])
      const lfgMessage = await lfgMessageChannel.messages.fetch(topic[2])
      if(!lfgMessage.flags.has(MessageFlags.Ephemeral)) await lfgMessage.delete()
    }

    await textChannel.delete()
    await voiceChannel.delete()
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
